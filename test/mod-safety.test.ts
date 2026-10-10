import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyInstallPlan, checkInstallPlan, installProjects, resolveInstallPlan } from '../dist/src/installer.js';
import { readLock, writeConfig, writeLock } from '../dist/src/config.js';
import { removeCommand } from '../dist/src/commands/remove.js';
import { updateProjects } from '../dist/src/commands/update.js';
import { filenameKey } from '../dist/src/mod-files.js';

import type { ApiServices, InstalledMod, Lockfile, ModrinthDependency, ModrinthFile, ModrinthVersion, ProjectConfig } from '../dist/src/types.js';
import { toError } from '../dist/src/errors.js';

let root: string;
let originalCwd: string;
let originalFetch: typeof fetch;
let originalProject: string | undefined;
let originalRename: typeof fs.rename;

type FixtureVersion = ModrinthVersion & { files: ModrinthFile[]; dependencies: ModrinthDependency[] };

const dependency = (projectId: string | null, versionId: string | null = null, type: ModrinthDependency['dependency_type'] = 'required'): ModrinthDependency => ({
  project_id: projectId, version_id: versionId, dependency_type: type
});
function version(projectId: string, id: string, dependencies: ModrinthDependency[] = [], filename = `${id}.jar`): FixtureVersion {
  return {
    id, project_id: projectId, version_number: id, version_type: 'release',
    game_versions: ['1.21.1'], loaders: ['fabric'], dependencies,
    files: [{ filename, primary: true, url: `https://example.test/${id}.jar` }]
  };
}
function apiFor(latest: Record<string, FixtureVersion | FixtureVersion[]>, versions: Record<string, FixtureVersion> = {}): ApiServices {
  return {
    getProject: async id => ({ id, slug: id, title: id }),
    getProjectVersions: async id => {
      const selected = latest[id];
      return selected ? (Array.isArray(selected) ? selected : [selected]) : [];
    },
    getVersion: async id => {
      assert.ok(versions[id], `Unexpected version lookup: ${id}`);
      return versions[id];
    }
  };
}
function lockEntry(v: FixtureVersion, isDependency = false): InstalledMod {
  return {
    title: v.project_id, slug: v.project_id, versionId: v.id, version: v.version_number,
    filename: v.files[0].filename, isDependency,
    dependencies: v.dependencies.filter(dep => dep.dependency_type === 'required').flatMap(dep => dep.project_id ? [dep.project_id] : [])
  };
}
async function profile(slugs: string[] = [], installed: Lockfile['installed'] = {}) {
  const config: ProjectConfig = { minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods',
    mods: Object.fromEntries(slugs.map(slug => [slug, 'latest'])) };
  const lock = { minecraftVersion: config.minecraftVersion, loader: config.loader, installed };
  await writeConfig(config, root);
  await writeLock(lock, root);
  await fs.mkdir(path.join(root, 'mods'));
  for (const mod of Object.values(installed)) {
    await fs.writeFile(path.join(root, 'mods', mod.filename), mod.versionId || mod.version);
  }
  return { config, lock };
}
interface Snapshot { [name: string]: Snapshot | { contents: string; mtimeMs: number } }

function directorySnapshot(snapshot: Snapshot, name: string): Snapshot {
  const directory = snapshot[name];
  assert.ok(directory && !('contents' in directory), `Expected directory: ${name}`);
  return directory as Snapshot;
}

async function snapshot(directory = root): Promise<Snapshot> {
  const files: Snapshot = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    files[entry.name] = entry.isDirectory() ? await snapshot(filePath) : {
      contents: await fs.readFile(filePath, 'utf8'), mtimeMs: (await fs.stat(filePath)).mtimeMs
    };
  }
  return files;
}
test.beforeEach(async () => {
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  originalProject = process.env.MCPM_PROJECT;
  originalRename = fs.rename;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-mod-safety-')));
  process.chdir(root);
  process.env.MCPM_PROJECT = root;
  globalThis.fetch = async url => new Response(`jar:${url}`);
});
test.afterEach(async () => {
  fs.rename = originalRename;
  globalThis.fetch = originalFetch;
  if (originalProject === undefined) delete process.env.MCPM_PROJECT;
  else process.env.MCPM_PROJECT = originalProject;
  process.chdir(originalCwd);
  await fs.rm(root, { recursive: true, force: true });
});

test('filename comparison follows macOS/Windows casing and preserves Linux casing', () => {
  for (const platform of ['darwin', 'win32']) {
    assert.equal(filenameKey('Case.jar', platform), filenameKey('case.jar', platform));
    assert.equal(filenameKey('caf\u00e9.jar', platform), filenameKey('cafe\u0301.jar', platform));
  }
  assert.notEqual(filenameKey('Case.jar', 'linux'), filenameKey('case.jar', 'linux'));
});

test('case-insensitive JAR collisions fail before downloads or profile changes', {
  skip: !['darwin', 'win32'].includes(process.platform)
}, async () => {
  const { config, lock } = await profile(['first', 'second']);
  const services = apiFor({ first: version('first', 'first-new', [], 'Case.jar'),
    second: version('second', 'second-new', [], 'case.jar') });
  const before = await snapshot();
  const checked = await checkInstallPlan(['first', 'second'], config, {}, services);
  assert.equal(checked.compatible, false);
  assert.match(checked.failures[0].message, /same file/);
  const plan = await resolveInstallPlan(['first', 'second'], config, {}, services);
  globalThis.fetch = async () => assert.fail('Collision must be rejected before downloading');
  await assert.rejects(applyInstallPlan(plan, config, lock, { projectRoot: root }), /same file/);
  assert.deepEqual(await snapshot(), before);
});

test('an install rollback keeps the backup when restoration fails and reports its location', async () => {
  const old = version('alpha', 'alpha-old');
  const next = version('alpha', 'alpha-new');
  const { config, lock } = await profile(['alpha'], { alpha: lockEntry(old) });
  const plan = await resolveInstallPlan(['alpha'], config, {}, apiFor({ alpha: next }));
  let backupPath: string | undefined;
  fs.rename = async (from, to) => {
    if (String(from).includes(`${path.sep}backup${path.sep}`)) {
      backupPath = String(from);
      throw Object.assign(new Error('restore denied'), { code: 'EACCES' });
    }
    if (to === path.join(root, 'mods', next.files[0].filename)) {
      throw Object.assign(new Error('install denied'), { code: 'EACCES' });
    }
    return originalRename(from, to);
  };
  await assert.rejects(applyInstallPlan(plan, config, lock, { projectRoot: root }), error => {
    assert.match(toError(error).message, /install denied.*Recovery files were kept/);
    assert.ok(backupPath);
    assert.equal(path.dirname(path.dirname(backupPath)), toError(error).recoveryDirectory);
    return true;
  });
  assert.ok(backupPath);
  assert.equal(await fs.readFile(backupPath, 'utf8'), old.id);
  assert.equal((await readLock(root)).installed.alpha.versionId, old.id);
});

test('a successful install rollback restores the previous JAR and cleans staging files', async () => {
  const old = version('alpha', 'alpha-old');
  const next = version('alpha', 'alpha-new');
  const { config, lock } = await profile(['alpha'], { alpha: lockEntry(old) });
  const plan = await resolveInstallPlan(['alpha'], config, {}, apiFor({ alpha: next }));
  const before = await snapshot();
  fs.rename = async (from, to) => {
    if (to === path.join(root, 'mods', next.files[0].filename)) throw new Error('install denied');
    return originalRename(from, to);
  };
  await assert.rejects(applyInstallPlan(plan, config, lock, { projectRoot: root }), /install denied/);
  assert.deepEqual(await snapshot(), before);
});

test('a removal rollback keeps the backup when its JAR cannot be restored', async () => {
  const old = version('alpha', 'alpha-old');
  await profile(['alpha'], { alpha: lockEntry(old) });
  let writeFailed = false;
  let backupPath: string | undefined;
  fs.rename = async (from, to) => {
    if (String(from).includes('.mcpm-staging-remove-')) {
      backupPath = String(from);
      throw Object.assign(new Error('restore denied'), { code: 'EACCES' });
    }
    if (!writeFailed && to === path.join(root, 'mcpm.json')) {
      writeFailed = true;
      throw Object.assign(new Error('state write denied'), { code: 'EACCES' });
    }
    return originalRename(from, to);
  };
  await assert.rejects(removeCommand('alpha'), error => {
    assert.match(toError(error).message, /state write denied.*Recovery files were kept/);
    assert.ok(backupPath);
    assert.equal(path.dirname(backupPath), toError(error).recoveryDirectory);
    return true;
  });
  assert.ok(backupPath);
  assert.equal(await fs.readFile(backupPath, 'utf8'), old.id);
  assert.equal((await readLock(root)).installed.alpha.versionId, old.id);
});

test('declared incompatible projects are rejected in either root order', async () => {
  const { config } = await profile();
  const services = apiFor({ first: version('first', 'first-new', [dependency('second', null, 'incompatible')]),
    second: version('second', 'second-new') });
  for (const roots of [['first', 'second'], ['second', 'first']]) {
    const checked = await checkInstallPlan(roots, config, {}, services);
    assert.equal(checked.compatible, false);
    assert.match(checked.failures[0].message, /Incompatible mods: first.*second/);
  }
  assert.equal((await checkInstallPlan(['first'], config, {}, services)).compatible, true);
});

test('a version-specific incompatibility only blocks the matching version', async () => {
  const { config } = await profile();
  const old = version('second', 'second-old');
  const next = version('second', 'second-new');
  const first = version('first', 'first-new', [dependency(null, old.id, 'incompatible')]);
  const allowed = await checkInstallPlan(['first', 'second'], config, {},
    apiFor({ first, second: next }, { [old.id]: old }));
  assert.equal(allowed.compatible, true);
  const blocked = await checkInstallPlan(['first', 'second'], config, {},
    apiFor({ first, second: old }, { [old.id]: old }));
  assert.equal(blocked.compatible, false);
});

test('late transitive pins replace obsolete dependencies and incompatibilities', async () => {
  const { config } = await profile();
  const one = version('a-shared', 'shared-one', [dependency('c-kept')]);
  const two = version('a-shared', 'shared-two', [dependency('b-orphan'), dependency('m-pins', null, 'incompatible')]);
  const latest = {
    root: version('root', 'root-new', [dependency('a-shared'), dependency('m-pins')]),
    'a-shared': two, 'm-pins': version('m-pins', 'pins-new', [dependency('a-shared', one.id)]),
    'b-orphan': version('b-orphan', 'orphan-new'), 'c-kept': version('c-kept', 'kept-new')
  };
  for (const dependencies of [latest.root.dependencies, [...latest.root.dependencies].reverse()]) {
    const plan = await resolveInstallPlan(['root'], config, {},
      apiFor({ ...latest, root: { ...latest.root, dependencies } }, { [one.id]: one }));
    assert.equal(plan.items.get('a-shared')?.version.id, one.id);
    assert.equal(plan.items.has('b-orphan'), false);
    assert.equal(plan.items.has('c-kept'), true);
  }
});

test('required dependency cycles terminate and conflicting exact pins still fail', async () => {
  const { config } = await profile();
  const one = version('shared', 'shared-one');
  const two = version('shared', 'shared-two');
  const latest = { first: version('first', 'first-new', [dependency('second'), dependency('shared', one.id)]),
    second: version('second', 'second-new', [dependency('first')]) };
  const cyclic = await resolveInstallPlan(['first'], config, {}, apiFor(latest, { [one.id]: one }));
  assert.equal(cyclic.items.size, 3);
  latest.second = version('second', 'second-new', [dependency('first'), dependency('shared', two.id)]);
  const checked = await checkInstallPlan(['first'], config, {}, apiFor(latest, { [one.id]: one, [two.id]: two }));
  assert.equal(checked.compatible, false);
  assert.match(checked.failures[0].message, /Dependency version conflict/);
});

test('install refuses to replace an exact dependency required by a retained direct mod', async () => {
  const one = version('shared', 'shared-one');
  const two = version('shared', 'shared-two');
  const alpha = version('alpha', 'alpha-old', [dependency('shared', one.id)]);
  const beta = version('beta', 'beta-new', [dependency('shared', two.id)]);
  const { config, lock } = await profile(['alpha'], { alpha: lockEntry(alpha), shared: lockEntry(one, true) });
  const before = await snapshot();
  globalThis.fetch = async () => assert.fail('Conflict must be rejected before downloading');
  await assert.rejects(installProjects(['beta'], {}, { config, lock, projectRoot: root,
    services: apiFor({ beta, shared: two }, { [alpha.id]: alpha, [one.id]: one, [two.id]: two }) }),
  /Dependency version conflict/);
  assert.deepEqual(await snapshot(), before);
});

test('installing an independent mod preserves existing direct mods and manual JARs', async () => {
  const one = version('shared', 'shared-one');
  const alpha = version('alpha', 'alpha-old', [dependency('shared', one.id)]);
  const beta = version('beta', 'beta-new');
  const { config, lock } = await profile(['alpha'], { alpha: lockEntry(alpha), shared: lockEntry(one, true) });
  await fs.writeFile(path.join(root, 'mods', 'manual.jar'), 'manual');
  const before = await snapshot();
  const installed = await installProjects(['beta'], {}, { config, lock, projectRoot: root,
    services: apiFor({ alpha: version('alpha', 'alpha-new'), beta }, { [alpha.id]: alpha, [one.id]: one }) });
  assert.equal(installed.lock.installed.alpha.versionId, alpha.id);
  assert.equal(installed.lock.installed.shared.versionId, one.id);
  const after = await snapshot();
  for (const filename of [alpha.files[0].filename, one.files[0].filename, 'manual.jar']) {
    assert.deepEqual(directorySnapshot(after, 'mods')[filename], directorySnapshot(before, 'mods')[filename]);
  }
});

test('partial updates preserve skipped direct mods and their exact dependencies', async () => {
  const one = version('shared', 'shared-one');
  const two = version('shared', 'shared-two');
  const alphaOld = version('alpha', 'alpha-old', [dependency('shared', one.id)]);
  const betaOld = version('beta', 'beta-old', [dependency('shared', one.id)]);
  const alphaNew = version('alpha', 'alpha-new', [dependency('shared', two.id)]);
  const betaNew = version('beta', 'beta-new', [dependency('shared', one.id)]);
  const { config, lock } = await profile(['alpha', 'beta'], {
    alpha: lockEntry(alphaOld), beta: lockEntry(betaOld), shared: lockEntry(one, true)
  });
  const before = await snapshot();
  const summary = await updateProjects(['alpha', 'beta'], {}, { config, lock, projectRoot: root,
    apiServices: apiFor({ alpha: alphaNew, beta: betaNew }, {
      [alphaOld.id]: alphaOld, [betaOld.id]: betaOld, [one.id]: one, [two.id]: two
    }) });
  assert.equal(summary.failures[0].slug, 'alpha');
  const result = await readLock(root);
  assert.equal(result.installed.alpha.versionId, alphaOld.id);
  assert.equal(result.installed.beta.versionId, betaNew.id);
  assert.equal(result.installed.shared.versionId, one.id);
  const after = await snapshot();
  for (const filename of [alphaOld.files[0].filename, one.files[0].filename]) {
    assert.deepEqual(directorySnapshot(after, 'mods')[filename], directorySnapshot(before, 'mods')[filename]);
  }
});

test('coupled mods can update together when neither update is safe alone', async () => {
  const one = version('shared', 'shared-one');
  const two = version('shared', 'shared-two');
  const alphaOld = version('alpha', 'alpha-old', [dependency('shared', one.id)]);
  const betaOld = version('beta', 'beta-old', [dependency('shared', one.id)]);
  const latest = { alpha: version('alpha', 'alpha-new', [dependency('shared', two.id)]),
    beta: version('beta', 'beta-new', [dependency('shared', two.id)]) };
  const { config, lock } = await profile(['alpha', 'beta'], {
    alpha: lockEntry(alphaOld), beta: lockEntry(betaOld), shared: lockEntry(one, true)
  });
  const summary = await updateProjects(['alpha', 'beta'], {}, { config, lock, projectRoot: root,
    apiServices: apiFor(latest, { [alphaOld.id]: alphaOld, [betaOld.id]: betaOld, [one.id]: one, [two.id]: two }) });
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.updated, 2);
  assert.equal((await readLock(root)).installed.shared.versionId, two.id);
});

test('installation protects versions from legacy lockfiles without version IDs', async () => {
  const one = version('shared', 'shared-one');
  const alphaOld = version('alpha', 'alpha-old', [dependency('shared', one.id)]);
  const alphaNext = version('alpha', 'alpha-new');
  const beta = version('beta', 'beta-new');
  const legacy = lockEntry(alphaOld);
  delete legacy.versionId;
  const { config, lock } = await profile(['alpha'], { alpha: legacy, shared: lockEntry(one, true) });
  const result = await installProjects(['beta'], {}, { config, lock, projectRoot: root,
    services: apiFor({ alpha: [alphaNext, alphaOld], beta }, { [alphaOld.id]: alphaOld, [one.id]: one }) });
  assert.equal(result.lock.installed.alpha.versionId, alphaOld.id);
  assert.equal(result.lock.installed.shared.versionId, one.id);
});

test('partial updates protect legacy direct mods without version IDs', async () => {
  const one = version('shared', 'shared-one');
  const two = version('shared', 'shared-two');
  const alphaOld = version('alpha', 'alpha-old', [dependency('shared', one.id)]);
  const betaOld = version('beta', 'beta-old', [dependency('shared', one.id)]);
  const legacy = lockEntry(alphaOld);
  delete legacy.versionId;
  const { config, lock } = await profile(['alpha', 'beta'], {
    alpha: legacy, beta: lockEntry(betaOld), shared: lockEntry(one, true)
  });
  const alphaNew = version('alpha', 'alpha-new', [dependency('shared', two.id)]);
  const betaNew = version('beta', 'beta-new', [dependency('shared', one.id)]);
  const summary = await updateProjects(['alpha', 'beta'], {}, { config, lock, projectRoot: root,
    apiServices: apiFor({ alpha: [alphaNew, alphaOld], beta: betaNew }, {
      [alphaOld.id]: alphaOld, [betaOld.id]: betaOld, [one.id]: one, [two.id]: two
    }) });
  assert.equal(summary.failures[0].slug, 'alpha');
  const result = await readLock(root);
  assert.equal(result.installed.alpha.versionId, alphaOld.id);
  assert.equal(result.installed.shared.versionId, one.id);
});

test('an API error for a skipped installed mod prevents unsafe partial writes', async () => {
  const one = version('shared', 'shared-one');
  const two = version('shared', 'shared-two');
  const alpha = version('alpha', 'alpha-old', [dependency('shared', one.id)]);
  const betaOld = version('beta', 'beta-old', [dependency('shared', one.id)]);
  const betaNew = version('beta', 'beta-new', [dependency('shared', two.id)]);
  const { config, lock } = await profile(['alpha', 'beta'], {
    alpha: lockEntry(alpha), beta: lockEntry(betaOld), shared: lockEntry(one, true)
  });
  const before = await snapshot();
  const api = apiFor({ beta: betaNew }, { [betaOld.id]: betaOld, [one.id]: one, [two.id]: two });
  const getVersion = api.getVersion;
  api.getVersion = async id => {
    if (id === alpha.id) throw new Error('API unavailable');
    return getVersion(id);
  };
  globalThis.fetch = async () => assert.fail('An unverified retained mod must block file changes');
  const summary = await updateProjects(['alpha', 'beta'], {}, { config, lock, projectRoot: root, apiServices: api });
  assert.equal(summary.updated, 0);
  const failure = summary.failures.find(failure => failure.slug === 'alpha');
  assert.ok(failure);
  assert.match(failure.message, /unverified: API unavailable/);
  assert.deepEqual(await snapshot(), before);
});
