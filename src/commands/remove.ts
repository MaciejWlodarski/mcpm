import type { Lockfile, ProjectConfig } from '../types.js';
import { toError } from '../errors.js';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import pc from 'picocolors';
import {
  getProjectRootForConfig,
  isInitialized,
  requireConfig,
  writeConfig,
  readLock,
  resolveModsDir,
  writeLock
} from '../config.js';

function collectRequiredDependencies(installed: Lockfile['installed']) {
  const required = new Set<string>();

  function visit(projectId: string) {
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

function getManagedFilePath(modsDir: string, filename: string) {
  if (!filename || filename !== path.basename(filename) || filename === '.' || filename === '..') {
    throw new Error(`Unsafe filename in the lockfile: ${filename || '<empty>'}`);
  }
  return path.join(modsDir, filename);
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function persistState(nextConfig: ProjectConfig, nextLock: Lockfile, previousConfig: ProjectConfig, previousLock: Lockfile, projectRoot: string) {
  try {
    await writeConfig(nextConfig, projectRoot);
    await writeLock(nextLock, projectRoot);
  } catch (errorCause) {
    const error = toError(errorCause);
    try {
      await writeConfig(previousConfig, projectRoot);
      await writeLock(previousLock, projectRoot);
    } catch (rollbackErrorCause) {
      const rollbackError = toError(rollbackErrorCause);
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}

/**
 * Removes a mod and cleans up dependencies no longer reachable from direct mods.
 * @param {string} slugOrId The slug or ID of the mod to uninstall.
 */
export async function removeCommand(slugOrId: string) {
  if (!slugOrId || slugOrId.trim() === '') {
    throw new Error('Provide the slug or ID of the mod to remove. Example: mcpm remove sodium');
  }

  if (!(await isInitialized())) {
    throw new Error('No MCPM project found. Use "mcpm use <project>" or "mcpm init"');
  }

  const config = await requireConfig();
  const projectRoot = getProjectRootForConfig(config)!;
  const modsDir = resolveModsDir(config, projectRoot);
  const lock = await readLock(projectRoot);
  const nextConfig = structuredClone(config);
  const nextLock = structuredClone(lock);
  const targetEntry = Object.entries(nextLock.installed || {})
    .find(([id, mod]) => id === slugOrId || mod.slug === slugOrId);

  if (!targetEntry) {
    throw new Error(`Mod "${slugOrId}" is not installed`);
  }

  const [targetId, targetMod] = targetEntry;
  delete nextConfig.mods?.[targetMod.slug];
  delete nextConfig.mods?.[targetId];

  const wasDirect = !targetMod.isDependency;
  targetMod.isDependency = true;
  const requiredAfterDemotion = collectRequiredDependencies(nextLock.installed);

  if (requiredAfterDemotion.has(targetId)) {
    if (!wasDirect) {
      const dependents = Object.values(nextLock.installed)
        .filter(mod => (mod.dependencies || []).includes(targetId))
        .map(mod => mod.title)
        .join(', ');
      throw new Error(
        `Cannot remove ${targetMod.title} because it is still required` +
        `${dependents ? ` by: ${dependents}` : ''}`
      );
    }

    await persistState(nextConfig, nextLock, config, lock, projectRoot);
    console.log(pc.green(
      `${targetMod.title} is no longer a direct mod, but remains installed as a required dependency.`
    ));
    return { removed: [], retainedAsDependency: targetId };
  }

  delete nextLock.installed[targetId];
  const required = collectRequiredDependencies(nextLock.installed);
  const removedMods = [{ id: targetId, ...targetMod }];

  for (const [projectId, mod] of Object.entries(nextLock.installed)) {
    if (mod.isDependency && !required.has(projectId)) {
      removedMods.push({ id: projectId, ...mod });
      delete nextLock.installed[projectId];
    }
  }

  const stagingDir = path.join(modsDir, `.mcpm-staging-remove-${randomUUID()}`);
  const backups = [];
  let stateWriteStarted = false;

  try {
    await fs.mkdir(stagingDir, { recursive: true });

    for (const mod of removedMods) {
      if (!mod.filename) continue;
      const originalPath = getManagedFilePath(modsDir, mod.filename);
      if (!(await pathExists(originalPath))) continue;
      const backupPath = path.join(stagingDir, `${randomUUID()}-${mod.filename}`);
      await fs.rename(originalPath, backupPath);
      backups.push({ originalPath, backupPath });
    }

    stateWriteStarted = true;
    await persistState(nextConfig, nextLock, config, lock, projectRoot);

    let cleanupWarning = null;
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (cleanupErrorCause) {
      const cleanupError = toError(cleanupErrorCause);
      cleanupWarning = cleanupError;
    }

    const orphanCount = removedMods.length - 1;
    const orphanLabel = orphanCount === 1
      ? '1 orphaned dependency'
      : `${orphanCount} orphaned dependencies`;
    console.log(pc.bold(pc.green(
      `Removed ${targetMod.title}${orphanCount > 0 ? ` and ${orphanLabel}` : ''}.`
    )));
    if (cleanupWarning) {
      console.warn(pc.yellow(`Warning: failed to remove the temporary directory: ${cleanupWarning.message}`));
    }
    return { removed: removedMods.map(mod => mod.id), retainedAsDependency: null, cleanupWarning };
  } catch (errorCause) {
    const error = toError(errorCause);
    let rollbackFailed = false;
    for (const backup of backups.reverse()) {
      try {
        await fs.rename(backup.backupPath, backup.originalPath);
      } catch (rollbackErrorCause) {
        const rollbackError = toError(rollbackErrorCause);
        rollbackFailed = true;
        error.rollbackError ||= rollbackError;
      }
    }

    if (stateWriteStarted) {
      try {
        await writeConfig(config, projectRoot);
        await writeLock(lock, projectRoot);
      } catch (rollbackErrorCause) {
        const rollbackError = toError(rollbackErrorCause);
        rollbackFailed = true;
        error.rollbackError ||= rollbackError;
      }
    }

    if (rollbackFailed) {
      error.recoveryDirectory = stagingDir;
      error.message += ` Recovery files were kept at ${stagingDir}.`;
    } else {
      try {
        await fs.rm(stagingDir, { recursive: true, force: true });
      } catch (rollbackErrorCause) {
        const rollbackError = toError(rollbackErrorCause);
        error.rollbackError ||= rollbackError;
      }
    }
    throw error;
  }
}
