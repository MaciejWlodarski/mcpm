import pc from 'picocolors';
import { getProjectRootForConfig, isInitialized, readConfig, readLock } from '../config.js';
import { installProjects } from '../installer.js';

const SUPPORTED_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);

/**
 * Changes the Minecraft version and reinstalls all direct mods atomically.
 * @param {string} newVersion The new Minecraft version.
 * @param {object} options Command line options.
 */
export async function upgradeCommand(newVersion, options = {}, installer = installProjects) {
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

  if (currentConfig.minecraftVersion === newVersion && currentConfig.loader === nextLoader) {
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
