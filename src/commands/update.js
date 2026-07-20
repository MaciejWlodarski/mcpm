import pc from 'picocolors';
import {
  getProjectRootForConfig,
  isInitialized,
  readConfig,
  readLock
} from '../config.js';
import { applyInstallPlan, resolveInstallPlan } from '../installer.js';

function installedBySlug(lock, slug) {
  return Object.values(lock.installed || {}).find(mod => mod.slug === slug && !mod.isDependency);
}

function pinnedVersions(directMods, updating, lock) {
  return Object.fromEntries(directMods.flatMap(slug => {
    if (updating.has(slug)) return [];
    const installed = installedBySlug(lock, slug);
    return installed?.versionId ? [[slug, installed.versionId]] : [];
  }));
}

async function updateIndependently(directMods, options, installer) {
  const summary = {
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
    } catch (error) {
      summary.failures.push({ slug, message: error.message });
      console.error(pc.yellow(`Skipped ${slug}: ${error.message}`));
    }
  }
  return summary;
}

export async function updateProjects(directMods, options = {}, services = {}) {
  // Preserve the small injected-function seam used by older integrations.
  if (typeof services === 'function') return updateIndependently(directMods, options, services);
  const summary = {
    checked: directMods.length,
    updated: 0,
    unchanged: 0,
    downloaded: 0,
    removed: 0,
    failures: []
  };

  const config = services.config || await readConfig();
  const projectRoot = services.projectRoot || getProjectRootForConfig(config);
  const lock = services.lock || await readLock(projectRoot);
  const resolvePlan = services.resolvePlan || resolveInstallPlan;
  const applyPlan = services.applyPlan || applyInstallPlan;
  const individuallyCompatible = [];
  for (const [index, slug] of directMods.entries()) {
    console.log(pc.cyan(`\n[${index + 1}/${directMods.length}] Checking ${pc.bold(slug)}...`));
    try {
      await resolvePlan([slug], config, options, services.apiServices);
      individuallyCompatible.push(slug);
    } catch (error) {
      summary.failures.push({ slug, message: error.message });
      console.error(pc.yellow(`Skipped ${slug}: ${error.message}`));
    }
  }

  const updating = new Set();
  let finalPlan = null;
  for (const slug of individuallyCompatible) {
    const tentative = new Set([...updating, slug]);
    try {
      finalPlan = await resolvePlan(directMods, config, {
        ...options,
        pinnedVersions: pinnedVersions(directMods, tentative, lock)
      }, services.apiServices);
      updating.add(slug);
    } catch (error) {
      summary.failures.push({ slug, message: error.message });
      console.error(pc.yellow(`Skipped ${slug}: ${error.message}`));
    }
  }

  if (updating.size === 0) return summary;
  finalPlan = await resolvePlan(directMods, config, {
    ...options,
    pinnedVersions: pinnedVersions(directMods, updating, lock)
  }, services.apiServices);
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
export async function updateCommand(options = {}) {
  if (!(await isInitialized())) {
    throw new Error('No MCPM project found. Use "mcpm use <project>" or "mcpm init"');
  }

  const config = await readConfig();
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
