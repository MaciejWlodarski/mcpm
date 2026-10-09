import pc from 'picocolors';
import { getProjectRootForConfig, isInitialized, readConfig, readLock, resolveModsDir } from '../config.js';
import { checkInstallPlan, installProjects } from '../installer.js';
import { findManualMods } from '../manual-mods.js';

const SUPPORTED_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);

/**
 * Checks a migration or changes the Minecraft version and reinstalls all direct mods atomically.
 * @param {string} newVersion The new Minecraft version.
 * @param {object} options Command line options.
 */
export async function upgradeCommand(newVersion, options = {}, installer = installProjects, services = {}) {
  if (!newVersion || newVersion.trim() === '') {
    throw new Error('Provide the new Minecraft version. Example: mcpm upgrade 1.21.1');
  }

  if (!(await isInitialized())) {
    throw new Error('No MCPM project found. Use "mcpm use <project>" or "mcpm init"');
  }

  const currentConfig = await readConfig();
  const projectRoot = getProjectRootForConfig(currentConfig);
  const currentLock = await readLock(projectRoot);
  const nextLoader = options.loader || currentConfig.loader;
  if (!SUPPORTED_LOADERS.has(nextLoader)) {
    throw new Error(
      `Unsupported loader "${nextLoader}". Choose fabric, forge, neoforge, or quilt.`
    );
  }

  if (!options.check && currentConfig.minecraftVersion === newVersion && currentConfig.loader === nextLoader) {
    console.log(pc.yellow(`The project already uses Minecraft ${newVersion} with ${nextLoader}.`));
    return null;
  }

  const nextConfig = structuredClone(currentConfig);
  nextConfig.minecraftVersion = newVersion;
  nextConfig.loader = nextLoader;
  const emptyLock = {
    minecraftVersion: newVersion,
    loader: nextLoader,
    allowBeta: options.beta === true || nextConfig.allowBeta === true,
    installed: {}
  };
  const directMods = Object.keys(nextConfig.mods || {});
  const manualMods = await findManualMods(resolveModsDir(currentConfig, projectRoot), currentLock);

  if (options.check) {
    console.log(pc.cyan(
      `Checking profile migration ${currentConfig.minecraftVersion}/${currentConfig.loader} -> ` +
      `${newVersion}/${nextLoader} for ${directMods.length} direct mods...`
    ));
    const result = await checkInstallPlan(directMods, nextConfig, options, services);
    result.manualMods = manualMods;
    if (!result.compatible) {
      console.log(pc.red('Upgrade check failed:'));
      for (const failure of result.failures) {
        console.log(`  ${failure.slug || 'Shared mod plan'}: ${failure.message}`);
      }
    } else {
      console.log(pc.green(
        `Compatible mod plan found for Minecraft ${newVersion} with ${nextLoader} ` +
        `(${result.plan.items.size} mods including required dependencies):`
      ));
      for (const [projectId, item] of result.plan.items) {
        const installed = currentLock.installed?.[projectId];
        const previousVersion = installed ? installed.version || 'unknown version' : 'not installed';
        console.log(
          `  ${item.project.title}: ${previousVersion} -> ${item.version.version_number}` +
          (item.isDependency ? ' (dependency)' : '')
        );
      }
    }
    if (manualMods.length > 0) {
      console.log(pc.yellow('Manual mods excluded from this check:'));
      for (const mod of manualMods) console.log(`  ${mod.filename}`);
    }
    console.log('No files were downloaded or changed.');
    return result;
  }

  if (manualMods.length > 0) {
    console.warn(pc.yellow('Manual mods are not updated by MCPM; verify their compatibility separately:'));
    for (const mod of manualMods) console.warn(`  ${mod.filename} (left unchanged)`);
  }

  console.log(pc.cyan(
    `Preparing profile migration ${currentConfig.minecraftVersion}/${currentConfig.loader} -> ` +
    `${newVersion}/${nextLoader} ` +
    `for ${directMods.length} mods...`
  ));

  const result = await installer(directMods, options, {
    config: nextConfig,
    lock: emptyLock,
    previousLock: currentLock,
    persistedConfig: currentConfig,
    persistedLock: currentLock,
    removeAllPrevious: true,
    projectRoot
  });
  if (result.cleanupWarning) {
    console.warn(pc.yellow(`Warning: failed to remove the temporary directory: ${result.cleanupWarning.message}`));
  }

  console.log(pc.bold(pc.green(
    `Migration to Minecraft ${newVersion} with ${nextLoader} completed successfully ` +
    `(downloaded: ${result.downloaded}, removed: ${result.removed}).`
  )));
  return result;
}
