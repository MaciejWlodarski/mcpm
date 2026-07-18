import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveInstallPlan, applyInstallPlan } from '../src/installer.js';
import { selectCompatibleVersion } from '../src/versioning.js';
import { readConfig, readLock, writeConfig, writeLock } from '../src/config.js';
import { removeCommand } from '../src/commands/remove.js';

const originalCwd = process.cwd();
let temporaryDirectory;
let originalFetch;

async function createProjectState(config, lock) {
  await writeConfig(config);
  await writeLock(lock);
  await fs.mkdir(config.modsDir, { recursive: true });
}

test.beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-test-'));
  process.chdir(temporaryDirectory);
  originalFetch = globalThis.fetch;
});

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test('nie wybiera wersji beta, gdy beta jest wyłączona', () => {
  const beta = {
    id: 'beta-version',
    version_number: '2.0.0-beta',
    version_type: 'beta',
    game_versions: ['1.21.1'],
    loaders: ['fabric']
  };

  assert.throws(
    () => selectCompatibleVersion([beta], '1.21.1', 'fabric', false),
    /Brak wersji typu release/
  );
  assert.equal(selectCompatibleVersion([beta], '1.21.1', 'fabric', true), beta);
});

test('resolver respektuje dokładne version_id wymaganej zależności', async () => {
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

test('resolver przerywa instalację, gdy brakuje wymaganej zależności', async () => {
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
    getVersion: async () => assert.fail('getVersion nie powinno zostać wywołane'),
    getProjectVersions: async id => id === 'root' ? [rootVersion] : []
  };

  await assert.rejects(
    resolveInstallPlan(['root'], {
      minecraftVersion: '1.21.1',
      loader: 'fabric',
      allowBeta: false
    }, {}, services),
    /Nie znaleziono kompatybilnej wersji dla Missing/
  );
});

test('awaria pobierania nie usuwa poprzedniego JAR-a ani lockfile', async () => {
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

test('udana instalacja podmienia pliki i zapisuje nowy stan', async () => {
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

test('remove zachowuje bezpośredni mod, jeśli nadal jest wymaganą zależnością', async () => {
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

test('remove odmawia usunięcia zależności nadal wymaganej przez mod', async () => {
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

  await assert.rejects(removeCommand('shared'), /nadal jest wymagana/);
  assert.ok((await readLock()).installed.shared);
  assert.equal(await fs.readFile(path.join(modsDir, 'shared.jar'), 'utf8'), 'shared');
});

test('remove usuwa mod bezpośredni wraz z osieroconą zależnością', async () => {
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
