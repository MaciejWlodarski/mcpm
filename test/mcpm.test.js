import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { resolveInstallPlan, applyInstallPlan } from '../src/installer.js';
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

test.beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-test-'));
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

  await configCommand({
    java: 'C:\\Java\\jdk-25',
    memory: '6g',
    resolution: '1600x900',
    gameDir: './game'
  });
  const launchConfig = await readConfig();
  assert.equal(launchConfig.launcher.javaPath, 'C:\\Java\\jdk-25');
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
    if (roots.length === 1 && roots[0] === 'firmament') throw new Error('No compatible version');
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
