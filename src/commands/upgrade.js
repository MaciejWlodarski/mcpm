import pc from 'picocolors';
import { getProjectRootForConfig, isInitialized, readConfig, readLock } from '../config.js';
import { installProjects } from '../installer.js';

/**
 * Changes the Minecraft version and reinstalls all direct mods atomically.
 * @param {string} newVersion The new Minecraft version.
 * @param {object} options Command line options.
 */
export async function upgradeCommand(newVersion, options = {}) {
  if (!newVersion || newVersion.trim() === '') {
    throw new Error('Podaj nową wersję Minecraft. Przykład: mcpm upgrade 1.21.1');
  }

  if (!(await isInitialized())) {
    throw new Error('Nie znaleziono projektu MCPM. Użyj "mcpm use <projekt>" albo "mcpm init"');
  }

  const currentConfig = await readConfig();
  const projectRoot = getProjectRootForConfig(currentConfig);
  const currentLock = await readLock(projectRoot);

  if (currentConfig.minecraftVersion === newVersion) {
    console.log(pc.yellow(`Projekt korzysta już z Minecraft ${newVersion}.`));
    return null;
  }

  const nextConfig = structuredClone(currentConfig);
  nextConfig.minecraftVersion = newVersion;
  const emptyLock = {
    minecraftVersion: newVersion,
    loader: nextConfig.loader,
    allowBeta: options.beta === true || nextConfig.allowBeta === true,
    installed: {}
  };
  const directMods = Object.keys(nextConfig.mods || {});

  console.log(pc.cyan(
    `Przygotowywanie migracji Minecraft ${currentConfig.minecraftVersion} -> ${newVersion} ` +
    `dla ${directMods.length} modyfikacji...`
  ));

  const result = await installProjects(directMods, options, {
    config: nextConfig,
    lock: emptyLock,
    previousLock: currentLock,
    persistedConfig: currentConfig,
    persistedLock: currentLock,
    removeAllPrevious: true,
    projectRoot
  });
  if (result.cleanupWarning) {
    console.warn(pc.yellow(`Ostrzeżenie: nie udało się usunąć katalogu tymczasowego: ${result.cleanupWarning.message}`));
  }

  console.log(pc.bold(pc.green(
    `Migracja do Minecraft ${newVersion} zakończona sukcesem ` +
    `(pobrano: ${result.downloaded}, usunięto: ${result.removed}).`
  )));
  return result;
}
