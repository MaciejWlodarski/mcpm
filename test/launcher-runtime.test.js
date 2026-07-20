import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { zipSync, strToU8 } from 'fflate';
import {
  evaluateArguments,
  mavenArtifactPath,
  resolveLaunchMetadata,
  rulesAllow
} from '../features/launcher/src/metadata.js';
import { downloadFile, resolveWithinDirectory } from '../features/launcher/src/downloads.js';
import { installJavaRuntime, resolveJava } from '../features/launcher/src/java-runtime.js';
import {
  prepareMinecraftRuntime,
  writePreparedRuntimeMarker
} from '../features/launcher/src/minecraft-runtime.js';
import {
  buildLaunchCommand,
  ensureProfileDirectories
} from '../features/launcher/src/launch.js';
import {
  findPreparedRuntime,
  launcherLoginCommand,
  profilesCommand
} from '../features/launcher/src/index.js';

function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function binaryResponse(value, status = 200) {
  return new Response(value, { status });
}

test('Mojang rules and Maven coordinates are evaluated for the current platform', () => {
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'windows' } }], {
    osName: 'windows', arch: 'x64', osVersion: '10.0.26100'
  }), true);
  assert.equal(rulesAllow([
    { action: 'allow' },
    { action: 'disallow', os: { name: 'windows', arch: 'arm64' } }
  ], { osName: 'windows', arch: 'arm64', osVersion: '10.0.26100' }), false);
  assert.deepEqual(evaluateArguments([
    'always',
    { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '1280'] }
  ], { features: { has_custom_resolution: true } }), ['always', '--width', '1280']);
  assert.equal(
    mavenArtifactPath('net.fabricmc:fabric-loader:0.19.3'),
    'net/fabricmc/fabric-loader/0.19.3/fabric-loader-0.19.3.jar'
  );
});

test('Fabric metadata is merged with the selected vanilla Minecraft profile', async () => {
  const fetchImpl = async url => {
    if (url.endsWith('version_manifest_v2.json')) {
      return jsonResponse({ versions: [{ id: '1.21.1', url: 'https://test/version.json' }] });
    }
    if (url === 'https://test/version.json') {
      return jsonResponse({
        id: '1.21.1',
        type: 'release',
        mainClass: 'net.minecraft.client.main.Main',
        libraries: [{ name: 'com.example:vanilla:1.0', downloads: { artifact: { path: 'vanilla.jar', url: 'https://test/vanilla.jar' } } }],
        arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}'] }
      });
    }
    if (url.endsWith('/versions/loader/1.21.1')) {
      return jsonResponse([{ loader: { version: '0.16.10', stable: true } }]);
    }
    if (url.endsWith('/versions/loader/1.21.1/0.16.10/profile/json')) {
      return jsonResponse({
        id: 'fabric-loader-0.16.10-1.21.1',
        inheritsFrom: '1.21.1',
        type: 'release',
        mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
        arguments: { jvm: ['-DFabric=true'], game: [] },
        libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.10', url: 'https://maven.fabricmc.net/' }]
      });
    }
    return jsonResponse({ error: `Unexpected URL ${url}` }, 404);
  };

  const metadata = await resolveLaunchMetadata({
    minecraftVersion: '1.21.1', loader: 'fabric'
  }, { fetchImpl });
  assert.equal(metadata.loaderVersion, '0.16.10');
  assert.equal(metadata.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.equal(metadata.libraries.length, 2);
  assert.deepEqual(metadata.arguments.jvm, ['-cp', '${classpath}', '-DFabric=true']);
});

test('unsupported loaders are rejected before metadata is requested', async () => {
  let requests = 0;
  await assert.rejects(resolveLaunchMetadata({
    minecraftVersion: '1.21.1', loader: 'neoforge'
  }, {
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse({});
    }
  }), /supports vanilla and Fabric/);
  assert.equal(requests, 0);
});

test('Minecraft runtime preparation downloads the client, libraries, natives, and assets', async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-runtime-'));
  const gameDirectory = path.join(stateDirectory, 'game');
  const client = Buffer.from('client');
  const library = Buffer.from('library');
  const nativeJar = Buffer.from(zipSync({
    'native.dll': strToU8('native'),
    'META-INF/MANIFEST.MF': strToU8('ignored')
  }));
  const asset = Buffer.from('asset');
  const assetHash = sha1(asset);
  const assetIndex = Buffer.from(JSON.stringify({
    objects: { 'minecraft/test.txt': { hash: assetHash, size: asset.length } }
  }));
  const responses = new Map([
    ['https://test/client.jar', client],
    ['https://test/library.jar', library],
    ['https://test/native.jar', nativeJar],
    ['https://test/assets.json', assetIndex],
    [`https://resources.download.minecraft.net/${assetHash.slice(0, 2)}/${assetHash}`, asset]
  ]);
  const fetchImpl = async url => responses.has(url)
    ? binaryResponse(responses.get(url))
    : binaryResponse('missing', 404);
  const metadata = {
    id: 'fabric-test',
    loader: 'fabric',
    loaderVersion: '0.16.10',
    profile: { id: 'fabric-test', type: 'release' },
    vanilla: {
      id: '1.21.1',
      downloads: { client: { url: 'https://test/client.jar', sha1: sha1(client), size: client.length } },
      assetIndex: { id: 'test', url: 'https://test/assets.json', sha1: sha1(assetIndex), size: assetIndex.length }
    },
    libraries: [{
      name: 'com.example:library:1.0',
      downloads: {
        artifact: { path: 'com/example/library/1.0/library-1.0.jar', url: 'https://test/library.jar', sha1: sha1(library), size: library.length },
        classifiers: {
          'natives-windows': { path: 'com/example/library/1.0/library-1.0-natives-windows.jar', url: 'https://test/native.jar', sha1: sha1(nativeJar), size: nativeJar.length }
        }
      },
      natives: { windows: 'natives-windows' }
    }]
  };

  try {
    const runtime = await prepareMinecraftRuntime(metadata, stateDirectory, gameDirectory, {
      fetchImpl,
      osName: 'windows',
      retries: 0,
      concurrency: 2
    });
    assert.equal(await fs.readFile(runtime.clientJar, 'utf8'), 'client');
    assert.equal(await fs.readFile(path.join(runtime.nativesDirectory, 'native.dll'), 'utf8'), 'native');
    assert.equal(runtime.classpath.length, 2);
    assert.equal(await fs.readFile(
      path.join(runtime.assetsDirectory, 'objects', assetHash.slice(0, 2), assetHash),
      'utf8'
    ), 'asset');
    await writePreparedRuntimeMarker(runtime, { executable: runtime.clientJar });
    assert.equal(JSON.parse(await fs.readFile(runtime.markerPath, 'utf8')).loaderVersion, '0.16.10');
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('Mojang Java runtime files are installed from the official component manifest', async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-java-'));
  const javaBinary = Buffer.from('java-runtime');
  const fetchImpl = async url => {
    if (url.includes('/products/java-runtime/')) {
      return jsonResponse({
        'windows-x64': {
          'java-runtime-test': [{
            manifest: { url: 'https://test/java-manifest.json', sha1: 'manifest' },
            version: { name: '25.0.1' }
          }]
        }
      });
    }
    if (url === 'https://test/java-manifest.json') {
      return jsonResponse({
        files: {
          bin: { type: 'directory' },
          'bin/java.exe': {
            type: 'file', executable: true,
            downloads: { raw: { url: 'https://test/java.exe', sha1: sha1(javaBinary), size: javaBinary.length } }
          }
        }
      });
    }
    if (url === 'https://test/java.exe') return binaryResponse(javaBinary);
    return binaryResponse('missing', 404);
  };

  try {
    const runtime = await installJavaRuntime('java-runtime-test', stateDirectory, {
      platform: 'windows-x64', fetchImpl, retries: 0
    });
    assert.equal(await fs.readFile(runtime.executable, 'utf8'), 'java-runtime');
    assert.equal(runtime.version, '25.0.1');
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('project directories connect the MCPM mod list to the game profile', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-profile-'));
  const gameDirectory = path.join(root, 'game');
  const modsDirectory = path.join(root, 'managed-mods');
  try {
    await fs.mkdir(modsDirectory, { recursive: true });
    await fs.writeFile(path.join(modsDirectory, 'example.jar'), 'mod');
    await ensureProfileDirectories({
      projectRoot: root,
      modsDir: modsDirectory,
      config: { gameDir: './game' }
    });
    assert.equal(await fs.realpath(path.join(gameDirectory, 'mods')), await fs.realpath(modsDirectory));
    assert.equal(await fs.readFile(path.join(gameDirectory, 'mods', 'example.jar'), 'utf8'), 'mod');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('launch command combines profile, account, memory, and resolution without a shell', () => {
  const context = {
    projectRoot: 'C:\\profiles\\skyblock',
    modsDir: 'C:\\profiles\\skyblock\\mods',
    config: {
      minecraftVersion: '1.21.1',
      loader: 'fabric',
      launcher: { memory: { min: '1G', max: '6G' }, resolution: { width: 1600, height: 900 } }
    }
  };
  const metadata = {
    id: 'fabric-test', loader: 'fabric', loaderVersion: '0.16.10',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    profile: { type: 'release' }, vanilla: { type: 'release' },
    arguments: {
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
      'default-user-jvm': ['-Xmx2G'],
      game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}', {
        rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
        value: ['--width', '${resolution_width}', '--height', '${resolution_height}']
      }]
    }
  };
  const runtime = {
    assetsDirectory: 'C:\\cache\\assets', assetIndexId: 'test',
    nativesDirectory: 'C:\\cache\\natives', launcherDirectory: 'C:\\cache',
    classpath: ['one.jar', 'two.jar'], logging: { argument: null }
  };
  const java = { executable: 'java', version: 'Java 21' };
  const session = {
    clientId: 'client-id',
    profile: { name: 'Steve', id: 'uuid' },
    minecraft: { accessToken: 'secret-token', xuid: 'xuid' }
  };
  const command = buildLaunchCommand(metadata, runtime, java, context, session);

  assert.equal(command.executable, 'java');
  assert.ok(command.args.includes('-Xmx6G'));
  assert.ok(command.args.includes('-Xms1G'));
  assert.ok(command.args.includes('net.fabricmc.loader.impl.launch.knot.KnotClient'));
  assert.ok(command.args.includes('secret-token'));
  assert.ok(command.args.includes('1600'));
  assert.ok(command.args.includes('900'));
  assert.equal(command.profile.account, 'Steve');
});

test('cached launcher files are repaired when their SHA-1 does not match', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-cache-'));
  const destination = path.join(directory, 'library.jar');
  const expected = Buffer.from('good');
  let requests = 0;
  try {
    await fs.writeFile(destination, 'evil');
    await downloadFile({
      url: 'https://test/library.jar',
      size: expected.length,
      sha1: sha1(expected)
    }, destination, {
      retries: 0,
      fetchImpl: async () => {
        requests += 1;
        return binaryResponse(expected);
      }
    });
    assert.equal(requests, 1);
    assert.equal(await fs.readFile(destination, 'utf8'), 'good');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('metadata paths cannot escape their launcher cache directory', () => {
  const root = path.join(os.tmpdir(), 'mcpm-safe-root');
  assert.throws(
    () => resolveWithinDirectory(root, '../outside.jar', 'library path'),
    /Unsafe library path/
  );
  assert.equal(
    resolveWithinDirectory(root, 'com/example/library.jar'),
    path.join(root, 'com', 'example', 'library.jar')
  );
});

test('one-off and stored Java paths use the correct base directory', async () => {
  const inspected = [];
  const inspectJava = executable => {
    inspected.push(executable);
    return { available: true, executable, version: 'test', majorVersion: 21 };
  };
  await resolveJava({ javaVersion: { majorVersion: 21 } }, {
    minecraftVersion: '1.21.1', launcher: { javaPath: './stored-jdk' }
  }, os.tmpdir(), { projectRoot: 'C:\\profiles\\test', inspectJava });
  assert.equal(inspected.pop(), path.join('C:\\profiles\\test', 'stored-jdk', 'bin', 'java.exe'));

  await resolveJava({ javaVersion: { majorVersion: 21 } }, {
    minecraftVersion: '1.21.1'
  }, os.tmpdir(), { java: './one-off-jdk', inspectJava });
  assert.equal(inspected.pop(), path.resolve('./one-off-jdk', 'bin', 'java.exe'));
});

test('launch rejects a maximum heap lower than the configured minimum', () => {
  const context = {
    projectRoot: 'C:\\profiles\\test',
    config: {
      minecraftVersion: '1.21.1', loader: 'fabric',
      launcher: { memory: { min: '512M', max: '256M' } }
    }
  };
  const metadata = {
    id: 'test', mainClass: 'Main', profile: {}, vanilla: {},
    arguments: { jvm: [], game: [] }
  };
  const runtime = {
    assetsDirectory: 'assets', assetIndexId: 'test', nativesDirectory: 'natives',
    launcherDirectory: 'launcher', classpath: [], logging: { argument: null }
  };
  const session = {
    profile: { name: 'Steve', id: 'uuid' }, minecraft: { accessToken: 'token' }
  };
  assert.throws(
    () => buildLaunchCommand(metadata, runtime, { executable: 'java' }, context, session),
    /cannot be lower/
  );
});

test('profile setup rejects recursive mods junctions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-cycle-'));
  try {
    await assert.rejects(ensureProfileDirectories({
      projectRoot: root,
      modsDir: path.join(root, 'mods'),
      config: { gameDir: './mods' }
    }), /paths overlap/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a stale runtime marker is not reported as prepared', async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-marker-'));
  const markerDirectory = path.join(stateDirectory, 'launcher', 'versions', 'test');
  try {
    await fs.mkdir(markerDirectory, { recursive: true });
    await fs.writeFile(path.join(markerDirectory, 'runtime.json'), JSON.stringify({
      id: 'test', minecraftVersion: '1.21.1', loader: 'fabric',
      requiredFiles: [path.join(stateDirectory, 'missing.jar')],
      javaExecutable: path.join(stateDirectory, 'missing-java.exe')
    }));
    assert.equal(await findPreparedRuntime(stateDirectory, {
      minecraftVersion: '1.21.1', loader: 'fabric'
    }), null);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('login can replace an unreadable saved session after successful authentication', async () => {
  let cleared = false;
  let saved = null;
  const session = {
    profile: { name: 'Steve', id: 'uuid' }, minecraft: { accessToken: 'token' }
  };
  await launcherLoginCommand({ getStateDirectory: () => 'state' }, {
    readSession: async () => { throw new Error('corrupt DPAPI data'); },
    createSession: async () => session,
    clearSession: async () => { cleared = true; },
    saveSession: async (_state, value) => { saved = value; }
  });
  assert.equal(cleared, true);
  assert.equal(saved, session);
});

test('one malformed profile does not abort the complete profile list', async () => {
  const projects = [
    { name: 'broken', path: 'broken', active: false, available: true },
    { name: 'healthy', path: 'healthy', active: true, available: true }
  ];
  const result = await profilesCommand({
    listProjects: async () => projects,
    getProjectContext: async name => {
      if (name === 'broken') throw new Error('invalid JSON');
      return {
        config: { minecraftVersion: '1.21.1', loader: 'fabric' },
        lock: { installed: {} }
      };
    }
  });
  assert.equal(result.length, 2);
});
