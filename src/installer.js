import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getProject, getProjectVersions, getVersion } from './api.js';
import { downloadFile } from './downloader.js';
import {
  getProjectRootForConfig,
  readConfig,
  readLock,
  resolveModsDir,
  writeConfig,
  writeLock
} from './config.js';
import { resolveProjectRoot } from './projects.js';
import { assertVersionCompatible, selectCompatibleVersion } from './versioning.js';
import { filenameKey } from './mod-files.js';

function clone(value) {
  return structuredClone(value);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function validateFilename(filename) {
  if (!filename || filename !== path.basename(filename) || filename === '.' || filename === '..') {
    throw new Error(`Unsafe filename received from the API: ${filename || '<empty>'}`);
  }
}

function cachedApi(services = {}) {
  const api = {};
  for (const [name, implementation] of Object.entries({
    getProject: services.getProject || getProject,
    getProjectVersions: services.getProjectVersions || getProjectVersions,
    getVersion: services.getVersion || getVersion
  })) {
    const requests = new Map();
    api[name] = (...args) => {
      const key = JSON.stringify(args);
      if (!requests.has(key)) requests.set(key, Promise.resolve().then(() => implementation(...args)));
      return requests.get(key);
    };
  }
  return api;
}

export async function resolveInstallPlan(rootSlugs, config, options = {}, services = {}) {
  const api = cachedApi(services);
  const allowBeta = options.beta === true || config.allowBeta === true;
  const rootProjectIds = new Set();
  const roots = new Map();
  for (const slug of [...new Set(rootSlugs)]) {
    const project = await api.getProject(slug);
    const pinnedVersionId = options.pinnedVersions?.[slug];
    const exactVersion = pinnedVersionId ? await api.getVersion(pinnedVersionId) : null;
    if (exactVersion && exactVersion.project_id !== project.id) {
      throw new Error(`Version ${exactVersion.id} does not belong to project ${project.title}`);
    }
    const previous = roots.get(project.id);
    if (previous?.exactVersion && exactVersion && previous.exactVersion.id !== exactVersion.id) {
      throw versionConflict(project, previous.exactVersion, exactVersion);
    }
    roots.set(project.id, { project, exactVersion: exactVersion || previous?.exactVersion || null });
    rootProjectIds.add(project.id);
  }

  function versionConflict(project, selected, required) {
    const error = new Error(
      `Dependency version conflict for ${project.title}: ${selected.version_number} and ${required.version_number}`
    );
    error.projectId = project.id;
    error.requiredVersion = required;
    return error;
  }

  // Rebuild constraints from reachable, selected versions on every search step.
  // Replacing a dependency version therefore also drops its obsolete dependencies.
  async function requirementsFor(selected) {
    const required = new Map([...roots].sort(([left], [right]) => left.localeCompare(right)));
    const dependencies = new Map();
    const queue = [...required.keys()];
    for (let index = 0; index < queue.length; index += 1) {
      const projectId = queue[index];
      const version = selected.get(projectId);
      if (!version) continue;
      const targets = new Set();
      for (const dependency of version.dependencies || []) {
        if (dependency.dependency_type !== 'required') continue;
        const exactVersion = dependency.version_id ? await api.getVersion(dependency.version_id) : null;
        const dependencyId = exactVersion?.project_id || dependency.project_id;
        if (!dependencyId) {
          throw new Error(`Dependency of ${required.get(projectId).project.title} has neither a project_id nor a valid version_id`);
        }
        const project = await api.getProject(dependencyId);
        targets.add(project.id);
        const existing = required.get(project.id);
        if (existing?.exactVersion && exactVersion && existing.exactVersion.id !== exactVersion.id) {
          throw versionConflict(project, existing.exactVersion, exactVersion);
        }
        if (!existing) queue.push(project.id);
        required.set(project.id, {
          project,
          exactVersion: exactVersion || existing?.exactVersion || null
        });
      }
      dependencies.set(projectId, [...targets]);
    }

    for (const [projectId, requirement] of required) {
      const version = selected.get(projectId);
      if (!version) continue;
      if (requirement.exactVersion && version.id !== requirement.exactVersion.id) {
        throw versionConflict(requirement.project, version, requirement.exactVersion);
      }
    }
    return { required, dependencies };
  }

  async function assertNoIncompatibleMods(selected, required) {
    for (const [projectId, requirement] of required) {
      const version = selected.get(projectId);
      for (const dependency of version.dependencies || []) {
        if (dependency.dependency_type !== 'incompatible') continue;
        const blockedVersion = dependency.version_id ? await api.getVersion(dependency.version_id) : null;
        const blockedId = blockedVersion?.project_id || dependency.project_id;
        const blocked = required.has(blockedId) ? selected.get(blockedId) : null;
        if (blocked && (!blockedVersion || blocked.id === blockedVersion.id)) {
          throw new Error(
            `Incompatible mods: ${requirement.project.title} ${version.version_number} and ` +
            `${required.get(blockedId).project.title} ${blocked.version_number}`
          );
        }
      }
    }
  }

  async function search(selected) {
    const graph = await requirementsFor(selected);
    const pending = [...graph.required.keys()].filter(id => !selected.has(id)).sort((left, right) =>
      Number(rootProjectIds.has(right)) - Number(rootProjectIds.has(left)) || left.localeCompare(right)
    );
    if (pending.length === 0) {
      await assertNoIncompatibleMods(selected, graph.required);
      return { selected, ...graph };
    }
    const projectId = pending[0];
    const { project, exactVersion } = graph.required.get(projectId);
    let candidate;
    if (exactVersion) {
      candidate = assertVersionCompatible(exactVersion, config.minecraftVersion, config.loader,
        allowBeta || Boolean(roots.get(projectId)?.exactVersion));
    } else {
      const versions = await api.getProjectVersions(projectId, config.minecraftVersion, config.loader);
      if (versions.length === 0) {
        throw new Error(`No compatible version found for ${project.title} ` +
          `(Minecraft ${config.minecraftVersion}, loader ${config.loader})`);
      }
      candidate = selectCompatibleVersion(versions, config.minecraftVersion, config.loader, allowBeta);
    }
    const candidates = [candidate];
    const tried = new Set();
    let firstError;
    for (let index = 0; index < candidates.length; index += 1) {
      const version = candidates[index];
      if (tried.has(version.id)) continue;
      tried.add(version.id);
      try {
        assertVersionCompatible(version, config.minecraftVersion, config.loader,
          allowBeta || Boolean(roots.get(projectId)?.exactVersion));
        return await search(new Map([...selected, [projectId, version]]));
      } catch (error) {
        firstError ||= error;
        // A constraint discovered later can replace an unconstrained latest choice.
        if (!exactVersion && error.projectId === projectId && error.requiredVersion) {
          candidates.push(error.requiredVersion);
        }
      }
    }
    throw firstError;
  }

  const graph = await search(new Map());
  const items = new Map();
  const versionToProject = new Map();
  for (const [projectId, { project }] of graph.required) {
    const version = graph.selected.get(projectId);
    items.set(projectId, { project, version, dependencies: graph.dependencies.get(projectId) || [],
      isDependency: !rootProjectIds.has(projectId) });
    versionToProject.set(version.id, projectId);
  }
  return { items, rootProjectIds, versionToProject, allowBeta };
}

function getPlanFiles(plan) {
  const files = new Map();
  const targetOwners = new Map();
  for (const [projectId, item] of plan.items) {
    const file = (item.version.files || []).find(candidate => candidate.primary) || item.version.files?.[0];
    if (!file) {
      throw new Error(`No downloadable file found for ${item.project.title} ${item.version.version_number}`);
    }
    validateFilename(file.filename);
    const key = filenameKey(file.filename);
    const owner = targetOwners.get(key);
    if (owner && owner !== projectId) {
      throw new Error(`Two mods are trying to install the same file: ${file.filename}`);
    }
    targetOwners.set(key, projectId);
    files.set(projectId, file);
  }
  return files;
}

export async function checkInstallPlan(rootSlugs, config, options = {}, services = {}) {
  const cachedServices = cachedApi(services);

  // The full plan is authoritative: another mod may pin a dependency to a
  // compatible version that an isolated check would not select on its own.
  let fullPlanError;
  try {
    const plan = await resolveInstallPlan(rootSlugs, config, options, cachedServices);
    getPlanFiles(plan);
    return { compatible: true, plan, failures: [] };
  } catch (error) {
    fullPlanError = error;
    // Diagnose every root and the remaining shared graph after a failed plan.
  }

  const failures = [];
  const compatibleRoots = [];
  for (const slug of [...new Set(rootSlugs)]) {
    try {
      const plan = await resolveInstallPlan([slug], config, options, cachedServices);
      getPlanFiles(plan);
      compatibleRoots.push(slug);
    } catch (error) {
      failures.push({ slug, message: error.message });
    }
  }

  // Individual mods can resolve successfully while their shared dependencies conflict.
  let plan = null;
  try {
    plan = await resolveInstallPlan(compatibleRoots, config, options, cachedServices);
    getPlanFiles(plan);
  } catch (error) {
    failures.push({ slug: null, message: error.message });
    plan = null;
  }
  if (failures.length === 0) failures.push({ slug: null, message: fullPlanError.message });
  return { compatible: false, plan, failures };
}

function collectRequiredDependencies(installed) {
  const required = new Set();

  function visit(projectId) {
    const mod = installed[projectId];
    if (!mod) return;

    for (const dependencyId of mod.dependencies || []) {
      if (required.has(dependencyId)) continue;
      required.add(dependencyId);
      visit(dependencyId);
    }
  }

  for (const [projectId, mod] of Object.entries(installed)) {
    if (!mod.isDependency) visit(projectId);
  }

  return required;
}

export async function applyInstallPlan(plan, config, lock, options = {}) {
  const projectRoot = options.projectRoot ||
    getProjectRootForConfig(config) ||
    await resolveProjectRoot();
  const modsDir = resolveModsDir(config, projectRoot);
  const previousLock = options.previousLock || lock;
  const persistedConfig = options.persistedConfig || config;
  const persistedLock = options.persistedLock || previousLock;
  const nextConfig = clone(config);
  const nextLock = clone(lock);
  nextConfig.mods ||= {};
  nextLock.installed ||= {};
  nextLock.minecraftVersion = config.minecraftVersion;
  nextLock.loader = config.loader;
  nextLock.allowBeta = plan.allowBeta;

  const downloads = [];
  const filesToRemove = new Set();
  const managedFiles = new Set(
    Object.values(previousLock.installed || {}).map(mod => mod.filename).filter(Boolean)
      .map(filename => filenameKey(filename))
  );
  const managedFileOwners = new Map();
  for (const [projectId, mod] of Object.entries(previousLock.installed || {})) {
    if (!mod.filename) continue;
    const key = filenameKey(mod.filename);
    const owners = managedFileOwners.get(key) || new Set();
    owners.add(projectId);
    managedFileOwners.set(key, owners);
  }
  const planFiles = getPlanFiles(plan);

  for (const [projectId, item] of plan.items) {
    const file = planFiles.get(projectId);

    const old = nextLock.installed[projectId];
    const remainsDirect = old?.isDependency === false;
    const entry = {
      title: item.project.title,
      slug: item.project.slug,
      version: item.version.version_number,
      versionId: item.version.id,
      filename: file.filename,
      dependencies: item.dependencies,
      isDependency: item.isDependency && !remainsDirect
    };

    if (plan.rootProjectIds.has(projectId)) {
      entry.isDependency = false;
      nextConfig.mods[item.project.slug] = 'latest';
    }

    const targetPath = path.join(modsDir, file.filename);
    const sameVersion = old?.versionId
      ? old.versionId === entry.versionId
      : old?.version === entry.version;
    const sameInstalledFile = old &&
      sameVersion &&
      old.filename === entry.filename &&
      await pathExists(targetPath);

    if (!sameInstalledFile) {
      downloads.push({ projectId, file, targetPath });
      if (old?.filename) filesToRemove.add(old.filename);
    }

    nextLock.installed[projectId] = entry;
  }

  const required = collectRequiredDependencies(nextLock.installed);
  for (const [projectId, mod] of Object.entries(nextLock.installed)) {
    if (mod.isDependency && !required.has(projectId)) {
      if (mod.filename) filesToRemove.add(mod.filename);
      delete nextLock.installed[projectId];
    }
  }

  if (options.removeAllPrevious) {
    for (const mod of Object.values(previousLock.installed || {})) {
      if (mod.filename) filesToRemove.add(mod.filename);
    }
  }

  await fs.mkdir(modsDir, { recursive: true });
  const stagingDir = path.join(modsDir, `.mcpm-staging-${randomUUID()}`);
  const backupDir = path.join(stagingDir, 'backup');
  const stagedFiles = [];
  const backups = [];
  const installedTargets = [];
  let stateWriteStarted = false;

  try {
    await fs.mkdir(stagingDir, { recursive: true });

    for (const download of downloads) {
      const key = filenameKey(download.file.filename);
      if (await pathExists(download.targetPath) && !managedFiles.has(key)) {
        throw new Error(`File ${download.file.filename} already exists and is not managed by MCPM`);
      }
      const otherOwners = [...(managedFileOwners.get(key) || [])]
        .filter(ownerId => ownerId !== download.projectId && nextLock.installed[ownerId]);
      if (otherOwners.length > 0) {
        throw new Error(`File ${download.file.filename} already belongs to another installed mod`);
      }

      const projectStageDir = path.join(stagingDir, download.projectId);
      const stagedPath = await downloadFile(download.file.url, projectStageDir, download.file.filename);
      stagedFiles.push({ stagedPath, targetPath: download.targetPath });
    }

    await fs.mkdir(backupDir, { recursive: true });
    const pathsToBackup = new Set([...filesToRemove].map(filename => path.join(modsDir, filename)));
    for (const staged of stagedFiles) pathsToBackup.add(staged.targetPath);

    for (const originalPath of pathsToBackup) {
      if (!(await pathExists(originalPath))) continue;
      const backupPath = path.join(backupDir, `${randomUUID()}-${path.basename(originalPath)}`);
      await fs.rename(originalPath, backupPath);
      backups.push({ originalPath, backupPath });
    }

    for (const staged of stagedFiles) {
      await fs.rename(staged.stagedPath, staged.targetPath);
      installedTargets.push(staged.targetPath);
    }

    stateWriteStarted = true;
    await writeConfig(nextConfig, projectRoot);
    await writeLock(nextLock, projectRoot);

    let cleanupWarning = null;
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (cleanupError) {
      cleanupWarning = cleanupError;
    }

    return {
      config: nextConfig,
      lock: nextLock,
      downloaded: downloads.length,
      removed: filesToRemove.size,
      cleanupWarning
    };
  } catch (error) {
    let rollbackFailed = false;
    for (const targetPath of installedTargets.reverse()) {
      try {
        await fs.unlink(targetPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          rollbackFailed = true;
          error.cleanupError ||= cleanupError;
        }
      }
    }

    for (const backup of backups.reverse()) {
      try {
        await fs.rename(backup.backupPath, backup.originalPath);
      } catch (cleanupError) {
        rollbackFailed = true;
        error.cleanupError ||= cleanupError;
      }
    }

    if (stateWriteStarted) {
      try {
        await writeConfig(persistedConfig, projectRoot);
        await writeLock(persistedLock, projectRoot);
      } catch (cleanupError) {
        rollbackFailed = true;
        error.cleanupError ||= cleanupError;
      }
    }

    if (rollbackFailed) {
      error.recoveryDirectory = stagingDir;
      error.message += ` Recovery files were kept at ${stagingDir}.`;
    } else {
      try {
        await fs.rm(stagingDir, { recursive: true, force: true });
      } catch (cleanupError) {
        error.cleanupError ||= cleanupError;
      }
    }

    throw error;
  }
}

export async function installedVersionId(projectId, mod, config, services = {}) {
  if (mod.versionId) return mod.versionId;
  const versions = await (services.getProjectVersions || getProjectVersions)(
    projectId, config.minecraftVersion, config.loader
  );
  const versionId = versions.find(version => version.version_number === mod.version &&
    (version.files || []).some(file => file.filename === mod.filename))?.id;
  if (!versionId) throw new Error(`Cannot verify the installed version of ${mod.title || mod.slug || projectId}.`);
  return versionId;
}

export async function installProjects(rootSlugs, options = {}, overrides = {}) {
  const config = overrides.config || await readConfig();
  const projectRoot = overrides.projectRoot ||
    getProjectRootForConfig(config) ||
    await resolveProjectRoot();
  const lock = overrides.lock || await readLock(projectRoot);
  const api = cachedApi(overrides.services);
  const roots = new Set(rootSlugs);
  const pins = { ...options.pinnedVersions };
  if (!overrides.removeAllPrevious) {
    const requestedIds = new Set();
    for (const slug of rootSlugs) requestedIds.add((await api.getProject(slug)).id);
    for (const slug of Object.keys(config.mods || {})) roots.add(slug);
    for (const [projectId, mod] of Object.entries(lock.installed || {})) {
      if (mod.isDependency) continue;
      const slug = mod.slug || projectId;
      roots.add(slug);
      if (requestedIds.has(projectId)) continue;
      const versionId = await installedVersionId(projectId, mod, config, api);
      pins[slug] = versionId;
      // Configurations created with a project ID may also contain its canonical slug.
      for (const root of roots) {
        if ((await api.getProject(root)).id === projectId) pins[root] = versionId;
      }
    }
  }
  const plan = await resolveInstallPlan([...roots], config, { ...options, pinnedVersions: pins }, api);

  return applyInstallPlan(plan, config, lock, {
    previousLock: overrides.previousLock,
    persistedConfig: overrides.persistedConfig,
    persistedLock: overrides.persistedLock,
    removeAllPrevious: overrides.removeAllPrevious,
    projectRoot
  });
}
