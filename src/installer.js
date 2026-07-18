import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getProject, getProjectVersions, getVersion } from './api.js';
import { downloadFile } from './downloader.js';
import { readConfig, readLock, writeConfig, writeLock } from './config.js';
import { assertVersionCompatible, selectCompatibleVersion } from './versioning.js';

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
    throw new Error(`Niebezpieczna nazwa pliku otrzymana z API: ${filename || '<pusta>'}`);
  }
}

export async function resolveInstallPlan(rootSlugs, config, options = {}, services = {}) {
  const api = {
    getProject: services.getProject || getProject,
    getProjectVersions: services.getProjectVersions || getProjectVersions,
    getVersion: services.getVersion || getVersion
  };
  const allowBeta = options.beta === true || config.allowBeta === true;
  const items = new Map();
  const resolving = new Set();
  const versionToProject = new Map();
  const rootProjectIds = new Set();

  async function resolveProject(idOrSlug, { direct = false, exactVersion = null } = {}) {
    const project = await api.getProject(exactVersion?.project_id || idOrSlug);
    const projectId = project.id;

    if (exactVersion && exactVersion.project_id !== projectId) {
      throw new Error(`Wersja ${exactVersion.id} nie należy do projektu ${project.title}`);
    }

    const existing = items.get(projectId);
    if (existing) {
      if (exactVersion && existing.version.id !== exactVersion.id) {
        throw new Error(
          `Konflikt wersji zależności ${project.title}: ${existing.version.version_number} i ${exactVersion.version_number}`
        );
      }
      if (direct) {
        existing.isDependency = false;
        rootProjectIds.add(projectId);
      }
      return existing;
    }

    let version;
    if (exactVersion) {
      version = assertVersionCompatible(
        exactVersion,
        config.minecraftVersion,
        config.loader,
        allowBeta
      );
    } else {
      const versions = await api.getProjectVersions(
        projectId,
        config.minecraftVersion,
        config.loader
      );
      if (versions.length === 0) {
        throw new Error(
          `Nie znaleziono kompatybilnej wersji dla ${project.title} ` +
          `(Minecraft ${config.minecraftVersion}, loader ${config.loader})`
        );
      }
      version = selectCompatibleVersion(
        versions,
        config.minecraftVersion,
        config.loader,
        allowBeta
      );
    }

    const item = {
      project,
      version,
      dependencies: [],
      isDependency: !direct
    };
    items.set(projectId, item);
    versionToProject.set(version.id, projectId);
    if (direct) rootProjectIds.add(projectId);

    if (resolving.has(projectId)) return item;
    resolving.add(projectId);

    try {
      const requiredDependencies = (version.dependencies || [])
        .filter(dependency => dependency.dependency_type === 'required');

      for (const dependency of requiredDependencies) {
        let dependencyVersion = null;
        let dependencyProjectId = dependency.project_id;

        if (dependency.version_id) {
          dependencyVersion = await api.getVersion(dependency.version_id);
          dependencyProjectId = dependencyVersion.project_id;
          versionToProject.set(dependencyVersion.id, dependencyProjectId);
        }

        if (!dependencyProjectId) {
          throw new Error(`Zależność moda ${project.title} nie zawiera project_id ani poprawnego version_id`);
        }

        const dependencyItem = await resolveProject(dependencyProjectId, {
          exactVersion: dependencyVersion
        });
        item.dependencies.push(dependencyItem.project.id);
      }

      item.dependencies = [...new Set(item.dependencies)];
      return item;
    } finally {
      resolving.delete(projectId);
    }
  }

  for (const slug of [...new Set(rootSlugs)]) {
    await resolveProject(slug, { direct: true });
  }

  return { items, rootProjectIds, versionToProject, allowBeta };
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
  );
  const managedFileOwners = new Map();
  for (const [projectId, mod] of Object.entries(previousLock.installed || {})) {
    if (!mod.filename) continue;
    const owners = managedFileOwners.get(mod.filename) || new Set();
    owners.add(projectId);
    managedFileOwners.set(mod.filename, owners);
  }
  const targetOwners = new Map();

  for (const [projectId, item] of plan.items) {
    const file = (item.version.files || []).find(candidate => candidate.primary) || item.version.files?.[0];
    if (!file) {
      throw new Error(`Brak pliku do pobrania dla ${item.project.title} ${item.version.version_number}`);
    }
    validateFilename(file.filename);

    const owner = targetOwners.get(file.filename);
    if (owner && owner !== projectId) {
      throw new Error(`Dwa mody próbują zainstalować ten sam plik: ${file.filename}`);
    }
    targetOwners.set(file.filename, projectId);

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

    const targetPath = path.join(config.modsDir, file.filename);
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

  await fs.mkdir(config.modsDir, { recursive: true });
  const stagingDir = path.join(config.modsDir, `.mcpm-staging-${randomUUID()}`);
  const backupDir = path.join(stagingDir, 'backup');
  const stagedFiles = [];
  const backups = [];
  const installedTargets = [];
  let stateWriteStarted = false;

  try {
    await fs.mkdir(stagingDir, { recursive: true });

    for (const download of downloads) {
      if (await pathExists(download.targetPath) && !managedFiles.has(download.file.filename)) {
        throw new Error(`Plik ${download.file.filename} już istnieje i nie jest zarządzany przez MCPM`);
      }
      const otherOwners = [...(managedFileOwners.get(download.file.filename) || [])]
        .filter(ownerId => ownerId !== download.projectId && nextLock.installed[ownerId]);
      if (otherOwners.length > 0) {
        throw new Error(`Plik ${download.file.filename} należy już do innego zainstalowanego moda`);
      }

      const projectStageDir = path.join(stagingDir, download.projectId);
      const stagedPath = await downloadFile(download.file.url, projectStageDir, download.file.filename);
      stagedFiles.push({ stagedPath, targetPath: download.targetPath });
    }

    await fs.mkdir(backupDir, { recursive: true });
    const pathsToBackup = new Set([...filesToRemove].map(filename => path.join(config.modsDir, filename)));
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
    await writeConfig(nextConfig);
    await writeLock(nextLock);

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
    for (const targetPath of installedTargets.reverse()) {
      try {
        await fs.unlink(targetPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError ||= cleanupError;
      }
    }

    for (const backup of backups.reverse()) {
      try {
        await fs.rename(backup.backupPath, backup.originalPath);
      } catch (cleanupError) {
        error.cleanupError ||= cleanupError;
      }
    }

    if (stateWriteStarted) {
      try {
        await writeConfig(persistedConfig);
        await writeLock(persistedLock);
      } catch (cleanupError) {
        error.cleanupError ||= cleanupError;
      }
    }

    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (cleanupError) {
      error.cleanupError ||= cleanupError;
    }

    throw error;
  }
}

export async function installProjects(rootSlugs, options = {}, overrides = {}) {
  const config = overrides.config || await readConfig();
  const lock = overrides.lock || await readLock();
  const plan = await resolveInstallPlan(rootSlugs, config, options, overrides.services);

  return applyInstallPlan(plan, config, lock, {
    previousLock: overrides.previousLock,
    persistedConfig: overrides.persistedConfig,
    persistedLock: overrides.persistedLock,
    removeAllPrevious: overrides.removeAllPrevious
  });
}
