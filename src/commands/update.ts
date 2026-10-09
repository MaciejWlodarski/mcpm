import type { ApiServices, InstallOptions, Lockfile, ModrinthProject, ModrinthVersion, ProjectConfig } from '../types.js';

interface UpdateSummary {
  checked: number;
  updated: number;
  unchanged: number;
  downloaded: number;
  removed: number;
  failures: { slug: string; message: string }[];
}
interface UpdateServices {
  config?: ProjectConfig;
  lock?: Lockfile;
  projectRoot?: string;
  resolvePlan?: typeof resolveInstallPlan;
  applyPlan?: typeof applyInstallPlan;
  apiServices?: Partial<ApiServices>;
}

import { toError } from '../errors.js';
import pc from 'picocolors';
import {
  getProject,
  getProjects,
  getProjectVersions,
  getVersion,
  getVersions
} from '../api.js';
import {
  getProjectRootForConfig,
  isInitialized,
  requireConfig,
  readLock
} from '../config.js';
import { applyInstallPlan, installedVersionId, resolveInstallPlan } from '../installer.js';

function installedBySlug(lock: Lockfile, slug: string) {
  return Object.entries(lock.installed || {})
    .find(([id, mod]) => (mod.slug === slug || id === slug) && !mod.isDependency)?.[1];
}

function pinnedVersions(directMods: string[], updating: Set<string>, installedVersions: Map<string, string>) {
  return Object.fromEntries(directMods.flatMap(slug => {
    if (updating.has(slug)) return [];
    const versionId = installedVersions.get(slug);
    return versionId ? [[slug, versionId]] : [];
  }));
}

function planRoots(directMods: string[], updating: Set<string>, retained: Set<string>) {
  return directMods.filter(slug => updating.has(slug) || retained.has(slug));
}

function cacheAsync<T>(cache: Map<string, Promise<T>>, key: string, loader: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, loader());
  return cache.get(key)!;
}

function cacheProject(projectCache: Map<string, Promise<ModrinthProject>>, project: ModrinthProject) {
  const cached = Promise.resolve(project);
  projectCache.set(project.id, cached);
  projectCache.set(project.slug, cached);
}

function createCachedApiServices(apiServices: Partial<ApiServices> | null = null, enablePrefetch = true) {
  const overrides = apiServices || {};
  const useDefaultBatchApi = apiServices === null;
  const projectCache = new Map<string, Promise<ModrinthProject>>();
  const versionsCache = new Map<string, Promise<ModrinthVersion[]>>();
  const versionCache = new Map<string, Promise<ModrinthVersion>>();
  const api = {
    getProject: overrides.getProject || getProject,
    getProjects: overrides.getProjects || (useDefaultBatchApi ? getProjects : null),
    getProjectVersions: overrides.getProjectVersions || getProjectVersions,
    getVersion: overrides.getVersion || getVersion,
    getVersions: overrides.getVersions || (useDefaultBatchApi ? getVersions : null)
  };

  return {
    getProject: (idOrSlug: string) => cacheAsync(
      projectCache,
      idOrSlug,
      () => api.getProject(idOrSlug)
    ),
    prefetchProjects: async (idsOrSlugs: string[]) => {
      if (!enablePrefetch || !api.getProjects) return;
      const missing = [...new Set(idsOrSlugs)]
        .filter(idOrSlug => idOrSlug && !projectCache.has(idOrSlug));
      if (missing.length === 0) return;
      try {
        const projects = await api.getProjects(missing);
        for (const project of projects) cacheProject(projectCache, project);
      } catch {
        // Batch prefetch is an optimization; per-project resolution reports real errors later.
      }
    },
    getProjectVersions: (projectId: string, minecraftVersion?: string, loader?: string) => cacheAsync(
      versionsCache,
      JSON.stringify([projectId, minecraftVersion, loader]),
      () => api.getProjectVersions(projectId, minecraftVersion, loader)
    ),
    getVersion: (versionId: string) => cacheAsync(
      versionCache,
      versionId,
      () => api.getVersion(versionId)
    ),
    prefetchVersions: async (versionIds: (string | undefined)[]) => {
      if (!enablePrefetch || !api.getVersions) return;
      const missing = [...new Set(versionIds)]
        .filter((versionId): versionId is string => Boolean(versionId && !versionCache.has(versionId)));
      if (missing.length === 0) return;
      try {
        const versions = await api.getVersions(missing);
        for (const version of versions) {
          versionCache.set(version.id, Promise.resolve(version));
        }
      } catch {
        // Batch prefetch is an optimization; per-version resolution reports real errors later.
      }
    }
  };
}

async function updateIndependently(directMods: string[], options: InstallOptions, installer: typeof import('../installer.js').installProjects) {
  const summary: UpdateSummary = {
    checked: directMods.length,
    updated: 0,
    unchanged: 0,
    downloaded: 0,
    removed: 0,
    failures: []
  };
  for (const [index, slug] of directMods.entries()) {
    console.log(pc.cyan(`\n[${index + 1}/${directMods.length}] Updating ${pc.bold(slug)}...`));
    try {
      const result = await installer([slug], options);
      summary.downloaded += result.downloaded;
      summary.removed += result.removed;
      if (result.downloaded === 0 && result.removed === 0) {
        summary.unchanged += 1;
        console.log(pc.gray(`${slug} is up to date.`));
      } else {
        summary.updated += 1;
        console.log(pc.green(`${slug} was updated.`));
      }
    } catch (errorCause) {
      const error = toError(errorCause);
      summary.failures.push({ slug, message: error.message });
      console.error(pc.yellow(`Skipped ${slug}: ${error.message}`));
    }
  }
  return summary;
}

export async function updateProjects(directMods: string[], options: InstallOptions = {}, services: UpdateServices | typeof import('../installer.js').installProjects = {}) {
  // Preserve the small injected-function seam used by older integrations.
  if (typeof services === 'function') return updateIndependently(directMods, options, services);
  const summary: UpdateSummary = {
    checked: directMods.length,
    updated: 0,
    unchanged: 0,
    downloaded: 0,
    removed: 0,
    failures: []
  };

  const config = services.config || await requireConfig();
  const projectRoot = services.projectRoot || getProjectRootForConfig(config)!;
  const lock = services.lock || await readLock(projectRoot);
  const resolvePlan = services.resolvePlan || resolveInstallPlan;
  const applyPlan = services.applyPlan || applyInstallPlan;
  const apiServices = createCachedApiServices(
    services.apiServices ?? null,
    !services.resolvePlan || Boolean(services.apiServices?.getProjects || services.apiServices?.getVersions)
  );
  await apiServices.prefetchProjects(directMods);
  await apiServices.prefetchVersions(
    Object.values(lock.installed || {}).map(mod => mod.versionId)
  );
  const individuallyCompatible = [];
  const retained = new Set<string>();
  const installedVersions = new Map<string, string>();
  const unverified = new Map<string, string>();
  for (const [index, slug] of directMods.entries()) {
    console.log(pc.cyan(`\n[${index + 1}/${directMods.length}] Checking ${pc.bold(slug)}...`));
    const installed = installedBySlug(lock, slug);
    if (installed) {
      try {
        const versionId = await installedVersionId(slug, installed, config, apiServices);
        installedVersions.set(slug, versionId);
        await resolvePlan([slug], config, {
          ...options, pinnedVersions: { [slug]: versionId }
        }, apiServices);
        retained.add(slug);
      } catch (errorCause) {
        const error = toError(errorCause);
        // A version already incompatible with this profile cannot constrain its updates.
        if (error.code !== 'MCPM_VERSION_INCOMPATIBLE') unverified.set(slug, error.message);
      }
    }
    try {
      await resolvePlan([slug], config, options, apiServices);
      individuallyCompatible.push(slug);
    } catch (errorCause) {
      const error = toError(errorCause);
      summary.failures.push({ slug, message: error.message });
      console.error(pc.yellow(`Skipped ${slug}: ${error.message}`));
    }
  }

  let updating = new Set(individuallyCompatible);
  let finalPlan = null;
  if (updating.size === 0) return summary;
  try {
    // Coupled mods may only become compatible when upgraded together.
    finalPlan = await resolvePlan(planRoots(directMods, updating, retained), config, {
      ...options, pinnedVersions: pinnedVersions(directMods, updating, installedVersions)
    }, apiServices);
  } catch {
    updating = new Set();
    for (const slug of individuallyCompatible) {
      const tentative = new Set([...updating, slug]);
      try {
        finalPlan = await resolvePlan(planRoots(directMods, tentative, retained), config, {
          ...options, pinnedVersions: pinnedVersions(directMods, tentative, installedVersions)
        }, apiServices);
        updating.add(slug);
      } catch (errorCause) {
        const error = toError(errorCause);
        summary.failures.push({ slug, message: error.message });
        console.error(pc.yellow(`Skipped ${slug}: ${error.message}`));
      }
    }
  }

  if (updating.size === 0 || !finalPlan) return summary;
  const unsafeRetained = [...unverified].filter(([slug]) => !updating.has(slug));
  if (unsafeRetained.length > 0) {
    for (const [slug, reason] of unsafeRetained) {
      const message = `Cannot safely update while the installed version of ${slug} is unverified: ${reason}`;
      const failure = summary.failures.find(item => item.slug === slug);
      if (failure) failure.message += `; ${message}`;
      else summary.failures.push({ slug, message });
      console.error(pc.yellow(message));
    }
    return summary;
  }
  const result = await applyPlan(finalPlan, config, lock, { projectRoot });
  summary.downloaded = result.downloaded;
  summary.removed = result.removed;
  if (result.cleanupWarning) {
    console.warn(pc.yellow(
      `Warning: failed to remove the temporary directory: ${result.cleanupWarning.message}`
    ));
  }
  for (const slug of updating) {
    const before = installedBySlug(lock, slug);
    const after = installedBySlug(result.lock, slug);
    const changed = !before || !after || before.versionId !== after.versionId ||
      before.filename !== after.filename;
    if (changed) {
      summary.updated += 1;
      console.log(pc.green(`${slug} was updated.`));
    } else {
      summary.unchanged += 1;
      console.log(pc.gray(`${slug} is up to date.`));
    }
  }

  return summary;
}

/**
 * Updates direct mods independently, keeping successful updates when another mod fails.
 * @param {object} options Command line options.
 */
export async function updateCommand(options: InstallOptions = {}) {
  if (!(await isInitialized())) {
    throw new Error('No MCPM project found. Use "mcpm use <project>" or "mcpm init"');
  }

  const config = await requireConfig();
  const directMods = Object.keys(config.mods || {});

  if (directMods.length === 0) {
    console.log(pc.yellow('There are no installed mods to update.'));
    return null;
  }

  console.log(pc.cyan(
    `Checking updates for ${directMods.length} mods` +
    `${options.beta || config.allowBeta ? ' (beta allowed)' : ''}...`
  ));

  const summary = await updateProjects(directMods, options);
  console.log('\n' + pc.bold('Update summary:'));
  console.log(`  Updated:          ${pc.green(summary.updated)}`);
  console.log(`  Already current:  ${pc.cyan(summary.unchanged)}`);
  console.log(`  Skipped:          ${summary.failures.length ? pc.yellow(summary.failures.length) : '0'}`);

  if (summary.failures.length > 0) {
    console.log(pc.yellow('\nFailed to update:'));
    for (const failure of summary.failures) {
      console.log(`  - ${failure.slug}: ${failure.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(pc.bold(pc.green('\nUpdate completed successfully.')));
  }

  return summary;
}
