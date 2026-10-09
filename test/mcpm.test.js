import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { EventEmitter } from 'events';
import { resolveInstallPlan, checkInstallPlan, applyInstallPlan } from '../src/installer.js';
import { selectCompatibleVersion } from '../src/versioning.js';
import {
  getProjectRootForConfig,
  getConfigPath,
  getLockPath,
  readConfig,
  readLock,
  resolveModsDir,
  writeConfig,
  writeLock
} from '../src/config.js';
import { removeCommand } from '../src/commands/remove.js';
import { configCommand } from '../src/commands/configure.js';
import { persistInitializedProject } from '../src/commands/init.js';
import { updateProjects } from '../src/commands/update.js';
import { upgradeCommand } from '../src/commands/upgrade.js';
import { addFileCommand, openModsCommand } from '../src/commands/manual-mods.js';
import { findManualMods } from '../src/manual-mods.js';
import { openDirectory } from '../src/open-directory.js';
import {
  installFeature,
  listFeatures,
  loadInstalledFeatures,
  uninstallFeature
} from '../src/features.js';
import {
  forgetProject,
  listProjects,
  registerProject,
  setActiveProject
} from '../src/projects.js';

const originalCwd = process.cwd();
const cliPath = fileURLToPath(new URL('../bin/mcpm.js', import.meta.url));
const launcherFeaturePath = fileURLToPath(new URL('../features/launcher', import.meta.url));
let temporaryDirectory;
let originalFetch;
let originalStateDirectory;
let originalProjectOverride;
let originalNpmCache;

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function createProjectState(config, lock) {
  await writeConfig(config, process.cwd());
  await writeLock(lock, process.cwd());
  await fs.mkdir(config.modsDir, { recursive: true });
}

async function snapshotProjectFiles(directory = temporaryDirectory) {
  const result = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath);
    result[entry.name] = {
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      contents: entry.isDirectory()
        ? await snapshotProjectFiles(filePath)
        : (await fs.readFile(filePath)).toString('base64')
    };
  }
  return result;
}

function upgradeVersion(projectId, overrides = {}) {
  return {
    id: `${projectId}-new`,
    project_id: projectId,
    version_number: '2.0.0',
    version_type: 'release',
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    dependencies: [],
    files: [{ filename: `${projectId}.jar`, url: `https://example.test/${projectId}.jar`, primary: true }],
    ...overrides
  };
}

async function createUpgradeProject(slugs = ['root'], allowBeta = false) {
  const modsDir = path.join(temporaryDirectory, 'mods');
  const installed = Object.fromEntries(slugs.map(slug => [slug, {
    title: slug, slug, version: '1.0.0', versionId: `${slug}-old`,
    filename: `${slug}-old.jar`, isDependency: false, dependencies: []
  }]));
  await createProjectState({
    minecraftVersion: '1.20.1', loader: 'fabric', modsDir, allowBeta,
    mods: Object.fromEntries(slugs.map(slug => [slug, 'latest']))
  }, { minecraftVersion: '1.20.1', loader: 'fabric', allowBeta, installed });
  for (const mod of Object.values(installed)) {
    await fs.writeFile(path.join(modsDir, mod.filename), `previous ${mod.slug} jar`);
  }
}

test.beforeEach(async () => {
  temporaryDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-test-')));
  process.chdir(temporaryDirectory);
  originalFetch = globalThis.fetch;
  originalStateDirectory = process.env.MCPM_STATE_DIR;
  originalProjectOverride = process.env.MCPM_PROJECT;
  originalNpmCache = process.env.npm_config_cache;
  process.env.MCPM_STATE_DIR = path.join(temporaryDirectory, 'state');
  process.env.npm_config_cache = path.join(temporaryDirectory, 'npm-cache');
  delete process.env.MCPM_PROJECT;
});

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalStateDirectory === undefined) delete process.env.MCPM_STATE_DIR;
  else process.env.MCPM_STATE_DIR = originalStateDirectory;
  if (originalProjectOverride === undefined) delete process.env.MCPM_PROJECT;
  else process.env.MCPM_PROJECT = originalProjectOverride;
  if (originalNpmCache === undefined) delete process.env.npm_config_cache;
  else process.env.npm_config_cache = originalNpmCache;
  process.chdir(originalCwd);
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test('does not select a beta version when beta support is disabled', () => {
  const beta = {
    id: 'beta-version',
    version_number: '2.0.0-beta',
    version_type: 'beta',
    game_versions: ['1.21.1'],
    loaders: ['fabric']
  };

  assert.throws(
    () => selectCompatibleVersion([beta], '1.21.1', 'fabric', false),
    /No release version is available/
  );
  assert.equal(selectCompatibleVersion([beta], '1.21.1', 'fabric', true), beta);
});

test('CLI separates mod updates from Minecraft version upgrades', () => {
  const result = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /init \[path\]/);
  assert.match(result.stdout, /update \[options\]\s+Update all mods/);
  assert.match(result.stdout, /upgrade \[options\] <version>/);
  assert.doesNotMatch(result.stdout, /upgrade-mc|update\|upgrade/);
  assert.match(result.stdout, /use <project>/);
  assert.match(result.stdout, /projects/);
  assert.match(result.stdout, /current/);
  assert.match(result.stdout, /forget <project>/);
  assert.match(result.stdout, /config \[options\]/);
  assert.match(result.stdout, /add-file <path>/);
  assert.match(result.stdout, /open-mods \[profile\]/);
});

test('manual JARs are discovered without registering files, directories, or managed mods', async () => {
  await createUpgradeProject();
  const modsDirectory = path.join(temporaryDirectory, 'mods');
  for (const filename of ['Manual Mod.JAR', 'another.jar', 'notes.txt', 'disabled.jar.disabled']) {
    await fs.writeFile(path.join(modsDirectory, filename), filename);
  }
  await fs.mkdir(path.join(modsDirectory, 'directory.jar'));
  await fs.mkdir(path.join(modsDirectory, 'nested'));
  await fs.writeFile(path.join(modsDirectory, 'nested', 'nested.jar'), 'nested');
  const before = await snapshotProjectFiles();
  const manual = await findManualMods(modsDirectory, await readLock());
  assert.deepEqual(manual.map(mod => mod.filename), ['another.jar', 'Manual Mod.JAR']);
  assert.deepEqual(await snapshotProjectFiles(), before);
  const result = spawnSync(process.execPath, [cliPath, 'list'], { encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Managed mods: 1/);
  assert.match(result.stdout, /Manual mods:\s+2/);
  assert.match(result.stdout, /Manual mods \(not managed by MCPM\)/);
  assert.match(result.stdout, /Manual Mod.JAR.*\(manual, compatibility unknown\)/);
  assert.doesNotMatch(result.stdout, /notes.txt|disabled.jar.disabled|directory.jar|nested.jar/);
  assert.deepEqual(await snapshotProjectFiles(), before);
});

test('list shows a manual-only profile and does not create a missing mods directory', async () => {
  await createUpgradeProject([]);
  const modsDirectory = path.join(temporaryDirectory, 'mods');
  await fs.writeFile(path.join(modsDirectory, 'manual.jar'), 'manual');
  const run = () => spawnSync(process.execPath, [cliPath, 'list'], { encoding: 'utf8', env: process.env });
  const listed = run();
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Managed mods: 0/);
  assert.match(listed.stdout, /manual.jar.*\(manual,/);
  assert.doesNotMatch(listed.stdout, /No mods are installed/);
  await fs.rm(modsDirectory, { recursive: true });
  const before = await snapshotProjectFiles();
  assert.deepEqual(await findManualMods(modsDirectory, await readLock()), []);
  assert.equal(run().status, 0);
  assert.deepEqual(await snapshotProjectFiles(), before);
});

test('manual JAR discovery includes file symlinks but ignores broken and directory symlinks', {
  skip: process.platform === 'win32'
}, async () => {
  await createUpgradeProject([]);
  const modsDirectory = path.join(temporaryDirectory, 'mods');
  const source = path.join(temporaryDirectory, 'source.jar');
  await fs.writeFile(source, 'manual');
  await fs.symlink(source, path.join(modsDirectory, 'linked.jar'));
  await fs.symlink(path.join(temporaryDirectory, 'missing.jar'), path.join(modsDirectory, 'broken.jar'));
  await fs.symlink(temporaryDirectory, path.join(modsDirectory, 'directory.jar'));
  assert.deepEqual((await findManualMods(modsDirectory, await readLock())).map(mod => mod.filename), ['linked.jar']);
});

test('add-file CLI copies a manual JAR, keeps its source, and leaves profile state unchanged', async () => {
  await createUpgradeProject([]);
  const source = path.join(temporaryDirectory, 'My Manual Mod.JAR');
  await fs.writeFile(source, 'manual jar');
  const before = await snapshotProjectFiles();
  const result = spawnSync(process.execPath, [cliPath, 'add-file', './My Manual Mod.JAR'], {
    encoding: 'utf8', env: process.env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /My Manual Mod.JAR \(manual, not managed by MCPM\)/);
  assert.equal(await fs.readFile(source, 'utf8'), 'manual jar');
  assert.equal(await fs.readFile(path.join(temporaryDirectory, 'mods', 'My Manual Mod.JAR'), 'utf8'), 'manual jar');
  const after = await snapshotProjectFiles();
  delete after.mods.contents['My Manual Mod.JAR'];
  after.mods.mtimeMs = before.mods.mtimeMs;
  assert.deepEqual(after, before);
  assert.deepEqual((await findManualMods(path.join(temporaryDirectory, 'mods'), await readLock()))
    .map(mod => mod.filename), ['My Manual Mod.JAR']);
});

test('add-file refuses to overwrite existing files or adopt a missing managed filename', async () => {
  await createUpgradeProject();
  const source = path.join(temporaryDirectory, 'manual.jar');
  const destination = path.join(temporaryDirectory, 'mods', 'manual.jar');
  await fs.writeFile(source, 'new manual jar');
  await fs.writeFile(destination, 'previous manual jar');
  const before = await snapshotProjectFiles();
  await assert.rejects(addFileCommand(source), /already exists.*not replaced/);
  assert.deepEqual(await snapshotProjectFiles(), before);
  const managedSource = path.join(temporaryDirectory, 'root-old.jar');
  await fs.writeFile(managedSource, 'replacement');
  await fs.unlink(path.join(temporaryDirectory, 'mods', 'root-old.jar'));
  const missingBefore = await snapshotProjectFiles();
  await assert.rejects(addFileCommand(managedSource), /already managed by MCPM/);
  assert.deepEqual(await snapshotProjectFiles(), missingBefore);
  const invalidSource = path.join(temporaryDirectory, 'notes.txt');
  await fs.writeFile(invalidSource, 'notes');
  await assert.rejects(addFileCommand(invalidSource), /must be .jar files/);
  await fs.mkdir(path.join(temporaryDirectory, 'directory.jar'));
  await assert.rejects(addFileCommand('./directory.jar'), /must be a file/);
});

test('open-mods resolves the current or named profile without changing the active profile', async () => {
  const first = path.join(temporaryDirectory, 'first');
  const second = path.join(temporaryDirectory, 'second');
  for (const root of [first, second]) {
    await writeConfig({ minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './Custom Mods', mods: {} }, root);
  }
  await registerProject(first, { name: 'first' });
  await registerProject(second, { name: 'second', activate: false });
  const opened = [];
  const services = { openDirectory: async directory => { opened.push(directory); } };
  assert.equal(await openModsCommand('second', services), path.join(second, 'Custom Mods'));
  assert.equal(await openModsCommand(null, services), path.join(first, 'Custom Mods'));
  assert.deepEqual(opened, [path.join(second, 'Custom Mods'), path.join(first, 'Custom Mods')]);
  assert.equal((await listProjects()).find(project => project.active).name, 'first');
  assert.equal((await fs.stat(opened[0])).isDirectory(), true);
  await assert.rejects(openModsCommand('second', {
    openDirectory: async () => { throw new Error('File manager unavailable'); }
  }), /File manager unavailable/);
});

test('folder opening preserves argument boundaries and reports file-manager failures', async () => {
  const directory = path.join(temporaryDirectory, 'Mods with spaces & $characters');
  const child = new EventEmitter();
  let request;
  const spawn = (executable, args, options) => {
    request = { executable, args, options };
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  await openDirectory(directory, { platform: 'darwin', spawn });
  assert.equal(request.executable, 'open');
  assert.deepEqual(request.args, [directory]);
  assert.equal(request.options.shell, false);
  await assert.rejects(openDirectory(directory, { platform: 'linux', spawn: () => {
    const failed = new EventEmitter();
    queueMicrotask(() => failed.emit('close', 1));
    return failed;
  } }), /Could not open the folder/);
  await assert.rejects(openDirectory(directory, { platform: 'darwin', spawn: () => {
    const failed = new EventEmitter();
    queueMicrotask(() => failed.emit('error', new Error('open not found')));
    return failed;
  } }), /open not found/);
  assert.throws(() => openDirectory(directory, { platform: 'freebsd' }), /not supported/);
});

test('beta setting is persisted in the project configuration and lock file', async () => {
  const modsDir = path.join(temporaryDirectory, 'mods');
  await createProjectState({
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    modsDir,
    allowBeta: false,
    mods: {}
  }, {
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    allowBeta: false,
    installed: {}
  });

  await configCommand({ beta: 'on' });
  assert.equal((await readConfig()).allowBeta, true);
  assert.equal((await readLock()).allowBeta, true);

  await configCommand({ beta: 'off' });
  assert.equal((await readConfig()).allowBeta, false);
  assert.equal((await readLock()).allowBeta, false);
  await assert.rejects(configCommand({ beta: 'maybe' }), /on, off/);

  const javaPath = path.join(temporaryDirectory, 'Java', 'jdk-25');
  await configCommand({
    java: javaPath,
    memory: '6g',
    resolution: '1600x900',
    gameDir: './game'
  });
  const launchConfig = await readConfig();
  assert.equal(launchConfig.launcher.javaPath, javaPath);
  assert.equal(launchConfig.launcher.memory.max, '6G');
  assert.deepEqual(launchConfig.launcher.resolution, { width: 1600, height: 900 });
  assert.equal(launchConfig.gameDir, './game');
  await assert.rejects(configCommand({ memory: '256M' }), /cannot be lower/);
  await assert.rejects(configCommand({ gameDir: modsDir }), /cannot overlap recursively/);
});

test('relative Java configuration is stored relative to the profile, not a later cwd', async () => {
  await createProjectState({
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods', mods: {}
  }, { minecraftVersion: '1.21.1', loader: 'fabric', installed: {} });
  await configCommand({ java: './jdk' });
  assert.equal((await readConfig()).launcher.javaPath, path.join(temporaryDirectory, 'jdk'));
});

test('failed project initialization rolls back newly created profile files', async () => {
  const projectRoot = path.join(temporaryDirectory, 'new-profile');
  await assert.rejects(persistInitializedProject(
    projectRoot,
    { minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods', mods: {} },
    { minecraftVersion: '1.21.1', loader: 'fabric', installed: {} },
    'new-profile',
    { writeLock: async () => { throw new Error('lock failed'); } }
  ), /lock failed/);
  await assert.rejects(fs.access(getConfigPath(projectRoot)), { code: 'ENOENT' });
  await assert.rejects(fs.access(getLockPath(projectRoot)), { code: 'ENOENT' });
});

test('upgrade changes the Minecraft version, loader, and complete mod plan together', async () => {
  await createProjectState({
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    modsDir: './mods',
    allowBeta: false,
    mods: { sodium: 'latest' }
  }, {
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    allowBeta: false,
    installed: { sodium: { slug: 'sodium', filename: 'sodium.jar', isDependency: false } }
  });
  let request;
  const result = await upgradeCommand('1.21.1', { loader: 'neoforge' }, async (...args) => {
    request = args;
    return { downloaded: 1, removed: 1, cleanupWarning: null };
  });

  assert.equal(result.downloaded, 1);
  assert.deepEqual(request[0], ['sodium']);
  assert.equal(request[2].config.minecraftVersion, '1.21.1');
  assert.equal(request[2].config.loader, 'neoforge');
  assert.equal(request[2].lock.minecraftVersion, '1.21.1');
  assert.equal(request[2].lock.loader, 'neoforge');
  assert.equal(request[2].removeAllPrevious, true);
});

test('upgrade --check resolves all mods and required dependencies without downloading or writing', async () => {
  await createUpgradeProject();
  const before = await snapshotProjectFiles();
  const requests = [];
  const versions = {
    root: upgradeVersion('root', {
      loaders: ['neoforge'],
      dependencies: [{ project_id: 'dependency', dependency_type: 'required' }]
    }),
    dependency: upgradeVersion('dependency', { loaders: ['neoforge'] })
  };
  const services = {
    getProject: async id => ({ id, slug: id, title: id }),
    getProjectVersions: async (id, version, loader) => {
      requests.push(id);
      assert.equal(version, '1.21.1');
      assert.equal(loader, 'neoforge');
      return [versions[id]];
    },
    getVersion: async () => assert.fail('No pinned dependency expected')
  };
  const result = await upgradeCommand('1.21.1', { check: true, loader: 'neoforge' },
    async () => assert.fail('Check must not invoke the installer'), services);

  assert.equal(result.compatible, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.plan.items.size, 2);
  assert.equal(result.plan.items.get('dependency').isDependency, true);
  assert.deepEqual(requests, ['root', 'dependency']);
  assert.deepEqual(await snapshotProjectFiles(), before);
});

test('upgrade --check reports every blocked direct mod, missing dependencies, and API failures', async () => {
  await createUpgradeProject(['missing-one', 'missing-two', 'needs-dependency', 'api-error', 'healthy']);
  const before = await snapshotProjectFiles();
  const services = {
    getProject: async id => ({ id, slug: id, title: id }),
    getProjectVersions: async id => {
      if (id === 'api-error') throw new Error('Modrinth API error (503): unavailable');
      if (id === 'needs-dependency') return [upgradeVersion(id, {
        dependencies: [{ project_id: 'missing-dependency', dependency_type: 'required' }]
      })];
      return id === 'healthy' ? [upgradeVersion(id)] : [];
    }
  };
  const result = await upgradeCommand('1.21.1', { check: true },
    async () => assert.fail('Check must not invoke the installer'), services);
  assert.equal(result.compatible, false);
  assert.deepEqual(result.failures.map(failure => failure.slug), [
    'missing-one', 'missing-two', 'needs-dependency', 'api-error'
  ]);
  assert.match(result.failures[2].message, /missing-dependency/);
  assert.match(result.failures[3].message, /503/);
  assert.equal(result.plan.items.has('healthy'), true);
  assert.deepEqual(await snapshotProjectFiles(), before);
});

test('upgrade checks the shared dependency graph even when another mod is already blocked', async () => {
  const versions = {
    first: upgradeVersion('first', {
      dependencies: [{ project_id: 'shared', version_id: 'shared-one', dependency_type: 'required' }]
    }),
    second: upgradeVersion('second', {
      dependencies: [{ project_id: 'shared', version_id: 'shared-two', dependency_type: 'required' }]
    }),
    'shared-one': upgradeVersion('shared', { id: 'shared-one', version_number: '1.0.0' }),
    'shared-two': upgradeVersion('shared', { id: 'shared-two' })
  };
  const pinnedRequests = [];
  const result = await checkInstallPlan(['blocked', 'first', 'second'], {
    minecraftVersion: '1.21.1', loader: 'fabric'
  }, {}, {
    getProject: async id => ({ id, slug: id, title: id }),
    getProjectVersions: async id => id === 'blocked' ? [] : [versions[id]],
    getVersion: async id => { pinnedRequests.push(id); return versions[id]; }
  });
  assert.equal(result.compatible, false);
  assert.equal(result.plan, null);
  assert.equal(result.failures[0].slug, 'blocked');
  assert.equal(result.failures[1].slug, null);
  assert.match(result.failures[1].message, /Dependency version conflict for shared/);
  assert.deepEqual(pinnedRequests, ['shared-one', 'shared-two']);
});

test('upgrade check accepts a full plan whose pinned dependencies cannot resolve in isolation', async () => {
  const versions = {
    'pins-shared': upgradeVersion('pins-shared', {
      dependencies: [{ project_id: 'shared', version_id: 'shared-one', dependency_type: 'required' }]
    }),
    'uses-shared': upgradeVersion('uses-shared', {
      dependencies: [
        { project_id: 'shared', dependency_type: 'required' },
        { project_id: 'pins-shared', dependency_type: 'required' }
      ]
    }),
    shared: upgradeVersion('shared', { id: 'shared-two' }),
    'shared-one': upgradeVersion('shared', { id: 'shared-one', version_number: '1.0.0' })
  };
  const config = { minecraftVersion: '1.21.1', loader: 'fabric' };
  const services = {
    getProject: async id => ({ id, slug: id, title: id }),
    getProjectVersions: async id => [versions[id]],
    getVersion: async id => versions[id]
  };
  await assert.rejects(resolveInstallPlan(['uses-shared'], config, {}, services), /Dependency version conflict/);
  const result = await checkInstallPlan(['pins-shared', 'uses-shared'], config, {}, services);
  assert.equal(result.compatible, true);
  assert.equal(result.plan.items.get('shared').version.id, 'shared-one');
});

test('upgrade --check applies both explicit and stored beta policy without changing it', async () => {
  await createUpgradeProject();
  for (const [allowBeta, beta, compatible] of [[false, false, false], [false, true, true], [true, false, true]]) {
    const config = await readConfig();
    config.allowBeta = allowBeta;
    await writeConfig(config);
    const before = await snapshotProjectFiles();
    const result = await upgradeCommand('1.21.1', { check: true, beta },
      async () => assert.fail('Check must not invoke the installer'), {
        getProject: async id => ({ id, slug: id, title: id }),
        getProjectVersions: async id => [upgradeVersion(id, { version_type: 'beta' })]
      });
    assert.equal(result.compatible, compatible);
    assert.deepEqual(await snapshotProjectFiles(), before);
  }
});

test('upgrade --check validates mods even when Minecraft and loader are unchanged', async () => {
  await createUpgradeProject();
  let checked = false;
  const result = await upgradeCommand('1.20.1', { check: true },
    async () => assert.fail('Check must not invoke the installer'), {
      getProject: async id => ({ id, slug: id, title: id }),
      getProjectVersions: async (_id, version) => {
        checked = true;
        assert.equal(version, '1.20.1');
        return [];
      }
    });
  assert.equal(checked, true);
  assert.equal(result.compatible, false);
});

test('upgrade check rejects missing, unsafe, and conflicting target JAR metadata', async () => {
  const services = files => ({
    getProject: async id => ({ id, slug: id, title: id }),
    getProjectVersions: async id => [upgradeVersion(id, { files: files[id] })]
  });
  const config = { minecraftVersion: '1.21.1', loader: 'fabric' };
  const missing = await checkInstallPlan(['root'], config, {}, services({ root: [] }));
  assert.equal(missing.compatible, false);
  assert.match(missing.failures[0].message, /No downloadable file/);
  const unsafe = await checkInstallPlan(['root'], config, {}, services({ root: [{ filename: '../outside.jar' }] }));
  assert.equal(unsafe.compatible, false);
  assert.match(unsafe.failures[0].message, /Unsafe filename/);
  const collision = await checkInstallPlan(['first', 'second'], config, {}, services({
    first: [{ filename: 'shared.jar' }], second: [{ filename: 'shared.jar' }]
  }));
  assert.equal(collision.compatible, false);
  assert.match(collision.failures[0].message, /same file: shared.jar/);
});

test('upgrade --check accepts an empty mod profile without creating directories or calling the API', async () => {
  await createUpgradeProject([]);
  const before = await snapshotProjectFiles();
  const result = await upgradeCommand('1.21.1', { check: true },
    async () => assert.fail('Check must not invoke the installer'), {
      getProject: async () => assert.fail('Empty profile must not call the API'),
      getProjectVersions: async () => assert.fail('Empty profile must not call the API')
    });
  assert.equal(result.compatible, true);
  assert.equal(result.plan.items.size, 0);
  assert.deepEqual(await snapshotProjectFiles(), before);
});

test('upgrade --check CLI returns the compatibility status, handles flags, and leaves files unchanged', async () => {
  await createUpgradeProject();
  await fs.writeFile(path.join(temporaryDirectory, 'mods', 'Manual Extra.jar'), 'manual jar');
  const preloadPath = path.join(temporaryDirectory, 'modrinth-fixture.cjs');
  const version = upgradeVersion('root', { version_type: 'beta', loaders: ['neoforge'] });
  await fs.writeFile(preloadPath, `
    globalThis.fetch = async input => {
      const url = new URL(input);
      if (url.origin !== 'https://api.modrinth.com') throw new Error('Unexpected download: ' + input);
      let value;
      if (url.pathname === '/v2/project/root') {
        value = { id: 'root', slug: 'root', title: 'Root' };
      } else if (url.pathname === '/v2/project/root/version') {
        if (url.searchParams.get('game_versions') !== JSON.stringify(['1.21.1']) ||
            url.searchParams.get('loaders') !== JSON.stringify(['neoforge'])) throw new Error('Wrong target filters');
        value = [${JSON.stringify(version)}];
      } else throw new Error('Unexpected API request: ' + input);
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    };
  `);
  const before = await snapshotProjectFiles();
  const run = extra => spawnSync(process.execPath, [
    '--require', preloadPath, cliPath, 'upgrade', '1.21.1', '--check', '--loader', 'neoforge', ...extra
  ], { encoding: 'utf8', env: process.env });
  const compatible = run(['--beta']);
  assert.equal(compatible.status, 0, compatible.stderr + compatible.stdout);
  assert.match(compatible.stdout, /Compatible mod plan found/);
  assert.match(compatible.stdout, /Root: 1\.0\.0 -> 2\.0\.0/);
  assert.match(compatible.stdout, /Manual mods excluded from this check:/);
  assert.match(compatible.stdout, /Manual Extra.jar/);
  const blocked = run([]);
  assert.equal(blocked.status, 1, blocked.stderr + blocked.stdout);
  assert.match(blocked.stdout, /root: No release version is available/);
  assert.match(blocked.stdout, /Manual mods excluded from this check:/);
  assert.deepEqual(await snapshotProjectFiles(), before);
  const help = spawnSync(process.execPath, [cliPath, 'upgrade', '--help'], { encoding: 'utf8', env: process.env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--check/);
});

test('upgrade --check ignores manual JARs without asking the API about them or changing its result', async () => {
  await createUpgradeProject();
  const manualPath = path.join(temporaryDirectory, 'mods', 'manual.jar');
  await fs.writeFile(manualPath, 'manual jar');
  const before = await snapshotProjectFiles();
  const result = await upgradeCommand('1.21.1', { check: true },
    async () => assert.fail('Check must not invoke the installer'), {
      getProject: async id => {
        assert.equal(id, 'root');
        return { id, slug: id, title: id };
      },
      getProjectVersions: async id => {
        assert.equal(id, 'root');
        return [upgradeVersion(id)];
      }
    });
  assert.equal(result.compatible, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.manualMods, [{ filename: 'manual.jar', path: manualPath }]);
  assert.deepEqual(await snapshotProjectFiles(), before);
});

test('managed profile upgrades and removals preserve manual JARs', async () => {
  await createUpgradeProject();
  const manualPath = path.join(temporaryDirectory, 'mods', 'manual.jar');
  await fs.writeFile(manualPath, 'manual jar');
  const before = await fs.stat(manualPath);
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.origin === 'https://api.modrinth.com') {
      const value = url.pathname.endsWith('/version')
        ? [upgradeVersion('root')]
        : { id: 'root', slug: 'root', title: 'Root' };
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    }
    assert.equal(input, 'https://example.test/root.jar');
    return new Response('new managed jar');
  };
  const result = await upgradeCommand('1.21.1');
  assert.equal(result.config.minecraftVersion, '1.21.1');
  assert.equal(await fs.readFile(manualPath, 'utf8'), 'manual jar');
  assert.equal((await fs.stat(manualPath)).mtimeMs, before.mtimeMs);
  await removeCommand('root');
  assert.deepEqual(await fs.readdir(path.join(temporaryDirectory, 'mods')), ['manual.jar']);
  assert.equal(await fs.readFile(manualPath, 'utf8'), 'manual jar');
  assert.equal((await fs.stat(manualPath)).mtimeMs, before.mtimeMs);
});

test('update skips an incompatible mod and updates the remaining mods', async () => {
  const calls = [];
  const installer = async ([slug]) => {
    calls.push(slug);
    if (slug === 'firmament') {
      throw new Error('No compatible version');
    }
    if (slug === 'sodium') return { downloaded: 1, removed: 1, cleanupWarning: null };
    return { downloaded: 0, removed: 0, cleanupWarning: null };
  };

  const summary = await updateProjects(['firmament', 'sodium', 'mod-menu'], {}, installer);

  assert.deepEqual(calls, ['firmament', 'sodium', 'mod-menu']);
  assert.equal(summary.updated, 1);
  assert.equal(summary.unchanged, 1);
  assert.deepEqual(summary.failures, [{
    slug: 'firmament',
    message: 'No compatible version'
  }]);
});

test('batch update pins skipped mods while resolving one dependency graph', async () => {
  const config = {
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods',
    mods: { firmament: 'latest', sodium: 'latest' }
  };
  const lock = { installed: {
    firmament: {
      slug: 'firmament', versionId: 'firmament-old', filename: 'firmament.jar', isDependency: false
    },
    sodium: {
      slug: 'sodium', versionId: 'sodium-old', filename: 'sodium-old.jar', isDependency: false
    }
  } };
  const combinedOptions = [];
  const resolvePlan = async (roots, _config, options) => {
    if (roots.length === 1 && roots[0] === 'firmament' && !options.pinnedVersions?.firmament) {
      throw new Error('No compatible version');
    }
    if (roots.length > 1) combinedOptions.push(options.pinnedVersions);
    return { roots, allowBeta: false, items: new Map() };
  };
  const applyPlan = async () => ({
    downloaded: 1,
    removed: 1,
    cleanupWarning: null,
    lock: { installed: {
      ...lock.installed,
      sodium: {
        slug: 'sodium', versionId: 'sodium-new', filename: 'sodium-new.jar', isDependency: false
      }
    } }
  });

  const summary = await updateProjects(['firmament', 'sodium'], {}, {
    config, lock, projectRoot: temporaryDirectory, resolvePlan, applyPlan
  });
  assert.equal(summary.updated, 1);
  assert.deepEqual(summary.failures, [{ slug: 'firmament', message: 'No compatible version' }]);
  assert.ok(combinedOptions.every(pins => pins.firmament === 'firmament-old'));
});

test('batch update excludes a skipped mod whose installed version is incompatible', async () => {
  const config = {
    minecraftVersion: '26.1.2', loader: 'fabric', modsDir: './mods',
    mods: { firmament: 'latest', sodium: 'latest' }
  };
  const lock = { installed: {
    firmament: {
      slug: 'firmament', versionId: 'firmament-old', filename: 'firmament.jar', isDependency: false
    },
    sodium: {
      slug: 'sodium', versionId: 'sodium-old', filename: 'sodium-old.jar', isDependency: false
    }
  } };
  const combinedRoots = [];
  const resolvePlan = async (roots, _config, options) => {
    if (roots.includes('firmament')) {
      if (options.pinnedVersions?.firmament) {
        throw new Error('Version firmament-old does not support Minecraft 26.1.2');
      }
      throw new Error('No compatible version');
    }
    combinedRoots.push(roots);
    return { roots, allowBeta: false, items: new Map() };
  };
  const applyPlan = async () => ({
    downloaded: 1,
    removed: 1,
    cleanupWarning: null,
    lock: { installed: {
      ...lock.installed,
      sodium: {
        slug: 'sodium', versionId: 'sodium-new', filename: 'sodium-new.jar', isDependency: false
      }
    } }
  });

  const summary = await updateProjects(['firmament', 'sodium'], {}, {
    config, lock, projectRoot: temporaryDirectory, resolvePlan, applyPlan
  });
  assert.equal(summary.updated, 1);
  assert.deepEqual(summary.failures, [{ slug: 'firmament', message: 'No compatible version' }]);
  assert.ok(combinedRoots.some(roots => roots.includes('sodium')));
  assert.ok(combinedRoots.every(roots => !roots.includes('firmament')));
});

test('a mocked update resolver does not trigger real API prefetch requests', async () => {
  const config = {
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods',
    mods: { sodium: 'latest' }
  };
  const lock = { installed: {} };
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('Unexpected network request');
  };

  try {
    await updateProjects(['sodium'], {}, {
      config,
      lock,
      projectRoot: temporaryDirectory,
      resolvePlan: async roots => ({ roots, allowBeta: false, items: new Map() }),
      applyPlan: async () => ({
        downloaded: 0,
        removed: 0,
        cleanupWarning: null,
        lock: { installed: {} }
      })
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 0);
});

test('batch update excludes skipped mods that cannot be pinned', async () => {
  const config = {
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods',
    mods: { firmament: 'latest', sodium: 'latest' }
  };
  const lock = { installed: {
    sodium: {
      slug: 'sodium', versionId: 'sodium-old', filename: 'sodium-old.jar', isDependency: false
    }
  } };
  const combinedRoots = [];
  const resolvePlan = async (roots) => {
    if (roots.includes('firmament')) throw new Error('No compatible version');
    if (roots.length > 1 || roots[0] === 'sodium') combinedRoots.push(roots);
    return { roots, allowBeta: false, items: new Map() };
  };
  const applyPlan = async () => ({
    downloaded: 1,
    removed: 1,
    cleanupWarning: null,
    lock: { installed: {
      sodium: {
        slug: 'sodium', versionId: 'sodium-new', filename: 'sodium-new.jar', isDependency: false
      }
    } }
  });

  const summary = await updateProjects(['firmament', 'sodium'], {}, {
    config, lock, projectRoot: temporaryDirectory, resolvePlan, applyPlan
  });
  assert.equal(summary.updated, 1);
  assert.deepEqual(summary.failures, [{ slug: 'firmament', message: 'No compatible version' }]);
  assert.ok(combinedRoots.every(roots => !roots.includes('firmament')));
});

test('the optional launcher can be installed, loaded, and uninstalled', async () => {
  assert.equal((await listFeatures()).find(feature => feature.name === 'launcher').installed, false);

  const installed = await installFeature('launcher', { source: launcherFeaturePath });
  assert.equal(installed.name, 'launcher');
  assert.equal(installed.version, '0.3.0');

  const program = new Command();
  const loaded = await loadInstalledFeatures(program);
  assert.deepEqual(loaded.failures, []);
  assert.deepEqual(loaded.loaded, [{ name: 'launcher', version: '0.3.0' }]);
  assert.ok(program.commands.some(command => command.name() === 'launcher'));
  assert.ok(program.commands.some(command => command.name() === 'profiles'));
  assert.ok(program.commands.some(command => command.name() === 'profile'));
  assert.ok(program.commands.some(command => command.name() === 'launch'));
  const launcher = program.commands.find(command => command.name() === 'launcher');
  assert.deepEqual(
    launcher.commands.map(command => command.name()),
    ['status', 'profiles', 'prepare', 'login', 'account', 'logout']
  );

  await uninstallFeature('launcher');
  assert.equal((await listFeatures()).find(feature => feature.name === 'launcher').installed, false);
});

test('the active project allows configuration reads from any directory', async () => {
  const firstRoot = path.join(temporaryDirectory, 'first');
  const secondRoot = path.join(temporaryDirectory, 'second');
  const outside = path.join(temporaryDirectory, 'outside');
  await fs.mkdir(outside, { recursive: true });

  await writeConfig({
    minecraftVersion: '1.20.1', loader: 'fabric', modsDir: './mods', mods: {}
  }, firstRoot);
  await writeConfig({
    minecraftVersion: '1.21.1', loader: 'neoforge', modsDir: './mods', mods: {}
  }, secondRoot);
  await registerProject(firstRoot, { name: 'first' });
  await registerProject(secondRoot, { name: 'second' });
  process.chdir(outside);

  assert.equal((await readConfig()).minecraftVersion, '1.21.1');
  await setActiveProject('first');
  const firstConfig = await readConfig();
  assert.equal(firstConfig.minecraftVersion, '1.20.1');
  assert.equal(
    resolveModsDir(firstConfig, getProjectRootForConfig(firstConfig)),
    path.join(firstRoot, 'mods')
  );
});

test('CLI lists the active project from outside its directory', async () => {
  const projectRoot = path.join(temporaryDirectory, 'project');
  const outside = path.join(temporaryDirectory, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await writeConfig({
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    modsDir: './mods',
    allowBeta: false,
    mods: {}
  }, projectRoot);
  await writeLock({
    minecraftVersion: '1.21.1', loader: 'fabric', allowBeta: false, installed: {}
  }, projectRoot);
  await registerProject(projectRoot, { name: 'project' });

  const result = spawnSync(process.execPath, [cliPath, 'list'], {
    cwd: outside,
    encoding: 'utf8',
    env: process.env
  });

  assert.equal(result.status, 0, result.stderr);
  const output = stripAnsi(result.stdout);
  assert.match(output, /Minecraft: 1\.21\.1/);
  assert.ok(output.includes(path.join(projectRoot, 'mods')));
});

test('a local project takes precedence over the globally active project', async () => {
  const localRoot = path.join(temporaryDirectory, 'local');
  const activeRoot = path.join(temporaryDirectory, 'active');
  const localSubdirectory = path.join(localRoot, 'config', 'nested');
  await fs.mkdir(localSubdirectory, { recursive: true });

  await writeConfig({
    minecraftVersion: '1.20.1', loader: 'fabric', modsDir: './mods', mods: {}
  }, localRoot);
  await writeConfig({
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods', mods: {}
  }, activeRoot);
  await registerProject(localRoot, { name: 'local' });
  await registerProject(activeRoot, { name: 'active' });
  process.chdir(localSubdirectory);

  const config = await readConfig();
  assert.equal(config.minecraftVersion, '1.20.1');
  assert.equal(getProjectRootForConfig(config), localRoot);
});

test('MCPM_PROJECT overrides the local and globally active projects', async () => {
  const localRoot = path.join(temporaryDirectory, 'local');
  const overrideRoot = path.join(temporaryDirectory, 'override');
  await writeConfig({
    minecraftVersion: '1.20.1', loader: 'fabric', modsDir: './mods', mods: {}
  }, localRoot);
  await writeConfig({
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods', mods: {}
  }, overrideRoot);
  await registerProject(localRoot, { name: 'local' });
  process.chdir(localRoot);
  process.env.MCPM_PROJECT = overrideRoot;

  const config = await readConfig();
  assert.equal(config.minecraftVersion, '1.21.1');
  assert.equal(getProjectRootForConfig(config), overrideRoot);
});

test('a project can be removed from the registry without deleting its files', async () => {
  const projectRoot = path.join(temporaryDirectory, 'registered');
  await writeConfig({
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods', mods: {}
  }, projectRoot);
  await registerProject(projectRoot, { name: 'registered' });

  await forgetProject('registered');

  assert.deepEqual(await listProjects(), []);
  assert.equal((await readConfig(projectRoot)).minecraftVersion, '1.21.1');
});

test('the resolver honors an exact version_id for a required dependency', async () => {
  const projects = {
    root: { id: 'root', slug: 'root', title: 'Root' },
    dependency: { id: 'dependency', slug: 'dependency', title: 'Dependency' }
  };
  const pinnedDependency = {
    id: 'dependency-pinned',
    project_id: 'dependency',
    version_number: '1.0.0',
    version_type: 'release',
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    dependencies: [],
    files: [{ filename: 'dependency.jar', url: 'https://example.test/dependency.jar', primary: true }]
  };
  const latestDependency = { ...pinnedDependency, id: 'dependency-latest', version_number: '2.0.0' };
  const rootVersion = {
    id: 'root-version',
    project_id: 'root',
    version_number: '1.0.0',
    version_type: 'release',
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    dependencies: [{
      project_id: 'dependency',
      version_id: 'dependency-pinned',
      dependency_type: 'required'
    }],
    files: [{ filename: 'root.jar', url: 'https://example.test/root.jar', primary: true }]
  };
  let genericDependencyLookup = false;
  const services = {
    getProject: async id => projects[id],
    getVersion: async id => {
      assert.equal(id, 'dependency-pinned');
      return pinnedDependency;
    },
    getProjectVersions: async id => {
      if (id === 'root') return [rootVersion];
      genericDependencyLookup = true;
      return [latestDependency];
    }
  };

  const plan = await resolveInstallPlan(['root'], {
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    allowBeta: false
  }, {}, services);

  assert.equal(plan.items.get('dependency').version.id, 'dependency-pinned');
  assert.equal(genericDependencyLookup, false);
});

test('the resolver stops installation when a required dependency is unavailable', async () => {
  const projects = {
    root: { id: 'root', slug: 'root', title: 'Root' },
    missing: { id: 'missing', slug: 'missing', title: 'Missing' }
  };
  const rootVersion = {
    id: 'root-version',
    project_id: 'root',
    version_number: '1.0.0',
    version_type: 'release',
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    dependencies: [{ project_id: 'missing', dependency_type: 'required' }],
    files: [{ filename: 'root.jar', url: 'https://example.test/root.jar', primary: true }]
  };
  const services = {
    getProject: async id => projects[id],
    getVersion: async () => assert.fail('getVersion should not be called'),
    getProjectVersions: async id => id === 'root' ? [rootVersion] : []
  };

  await assert.rejects(
    resolveInstallPlan(['root'], {
      minecraftVersion: '1.21.1',
      loader: 'fabric',
      allowBeta: false
    }, {}, services),
    /No compatible version found for Missing/
  );
});

test('a download failure preserves the previous JAR and lock file', async () => {
  const modsDir = path.join(temporaryDirectory, 'mods');
  const config = {
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    modsDir,
    allowBeta: false,
    mods: { root: 'latest' }
  };
  const lock = {
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    allowBeta: false,
    installed: {
      root: {
        title: 'Root',
        slug: 'root',
        version: '1.0.0',
        versionId: 'old-version',
        filename: 'old.jar',
        dependencies: [],
        isDependency: false
      }
    }
  };
  await createProjectState(config, lock);
  await fs.writeFile(path.join(modsDir, 'old.jar'), 'old');
  globalThis.fetch = async () => new Response('failure', { status: 503 });

  const plan = {
    allowBeta: false,
    rootProjectIds: new Set(['root']),
    items: new Map([['root', {
      project: { id: 'root', slug: 'root', title: 'Root' },
      version: {
        id: 'new-version',
        version_number: '2.0.0',
        dependencies: [],
        files: [{ filename: 'new.jar', url: 'https://example.test/new.jar', primary: true }]
      },
      dependencies: [],
      isDependency: false
    }]])
  };

  await assert.rejects(applyInstallPlan(plan, config, lock), /Status HTTP 503/);
  assert.equal(await fs.readFile(path.join(modsDir, 'old.jar'), 'utf8'), 'old');
  assert.equal((await readLock()).installed.root.version, '1.0.0');
  await assert.rejects(fs.access(path.join(modsDir, 'new.jar')), { code: 'ENOENT' });
});

test('a successful installation replaces files and saves the new state', async () => {
  const modsDir = path.join(temporaryDirectory, 'mods');
  const config = {
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    modsDir,
    allowBeta: false,
    mods: { root: 'latest' }
  };
  const lock = {
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    allowBeta: false,
    installed: {
      root: {
        title: 'Root', slug: 'root', version: '1.0.0', versionId: 'old-version',
        filename: 'old.jar', dependencies: [], isDependency: false
      }
    }
  };
  await createProjectState(config, lock);
  await fs.writeFile(path.join(modsDir, 'old.jar'), 'old');
  globalThis.fetch = async () => new Response('new');
  const plan = {
    allowBeta: false,
    rootProjectIds: new Set(['root']),
    items: new Map([['root', {
      project: { id: 'root', slug: 'root', title: 'Root' },
      version: {
        id: 'new-version', version_number: '2.0.0', dependencies: [],
        files: [{ filename: 'new.jar', url: 'https://example.test/new.jar', primary: true }]
      },
      dependencies: [],
      isDependency: false
    }]])
  };

  await applyInstallPlan(plan, config, lock);
  assert.equal(await fs.readFile(path.join(modsDir, 'new.jar'), 'utf8'), 'new');
  await assert.rejects(fs.access(path.join(modsDir, 'old.jar')), { code: 'ENOENT' });
  assert.equal((await readLock()).installed.root.versionId, 'new-version');
  assert.deepEqual(
    (await fs.readdir(modsDir)).filter(name => name.startsWith('.mcpm-staging-')),
    []
  );
});

test('remove retains a direct mod when it is still a required dependency', async () => {
  const modsDir = path.join(temporaryDirectory, 'mods');
  const config = {
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir, allowBeta: false,
    mods: { parent: 'latest', shared: 'latest' }
  };
  const lock = {
    minecraftVersion: '1.21.1', loader: 'fabric', allowBeta: false,
    installed: {
      parent: {
        title: 'Parent', slug: 'parent', version: '1', filename: 'parent.jar',
        dependencies: ['shared'], isDependency: false
      },
      shared: {
        title: 'Shared', slug: 'shared', version: '1', filename: 'shared.jar',
        dependencies: [], isDependency: false
      }
    }
  };
  await createProjectState(config, lock);
  await fs.writeFile(path.join(modsDir, 'parent.jar'), 'parent');
  await fs.writeFile(path.join(modsDir, 'shared.jar'), 'shared');

  const result = await removeCommand('shared');

  assert.equal(result.retainedAsDependency, 'shared');
  assert.equal((await readLock()).installed.shared.isDependency, true);
  assert.equal((await readConfig()).mods.shared, undefined);
  assert.equal(await fs.readFile(path.join(modsDir, 'shared.jar'), 'utf8'), 'shared');
});

test('remove refuses to delete a dependency that another mod still requires', async () => {
  const modsDir = path.join(temporaryDirectory, 'mods');
  const config = {
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir, allowBeta: false,
    mods: { parent: 'latest' }
  };
  const lock = {
    minecraftVersion: '1.21.1', loader: 'fabric', allowBeta: false,
    installed: {
      parent: {
        title: 'Parent', slug: 'parent', version: '1', filename: 'parent.jar',
        dependencies: ['shared'], isDependency: false
      },
      shared: {
        title: 'Shared', slug: 'shared', version: '1', filename: 'shared.jar',
        dependencies: [], isDependency: true
      }
    }
  };
  await createProjectState(config, lock);
  await fs.writeFile(path.join(modsDir, 'shared.jar'), 'shared');

  await assert.rejects(removeCommand('shared'), /still required/);
  assert.ok((await readLock()).installed.shared);
  assert.equal(await fs.readFile(path.join(modsDir, 'shared.jar'), 'utf8'), 'shared');
});

test('remove deletes a direct mod together with its orphaned dependency', async () => {
  const modsDir = path.join(temporaryDirectory, 'mods');
  const config = {
    minecraftVersion: '1.21.1', loader: 'fabric', modsDir, allowBeta: false,
    mods: { parent: 'latest' }
  };
  const lock = {
    minecraftVersion: '1.21.1', loader: 'fabric', allowBeta: false,
    installed: {
      parent: {
        title: 'Parent', slug: 'parent', version: '1', filename: 'parent.jar',
        dependencies: ['orphan'], isDependency: false
      },
      orphan: {
        title: 'Orphan', slug: 'orphan', version: '1', filename: 'orphan.jar',
        dependencies: [], isDependency: true
      }
    }
  };
  await createProjectState(config, lock);
  await fs.writeFile(path.join(modsDir, 'parent.jar'), 'parent');
  await fs.writeFile(path.join(modsDir, 'orphan.jar'), 'orphan');

  const result = await removeCommand('parent');

  assert.deepEqual(new Set(result.removed), new Set(['parent', 'orphan']));
  assert.deepEqual((await readLock()).installed, {});
  assert.deepEqual((await readConfig()).mods, {});
  await assert.rejects(fs.access(path.join(modsDir, 'parent.jar')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(modsDir, 'orphan.jar')), { code: 'ENOENT' });
});
