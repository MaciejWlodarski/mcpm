import pc from 'picocolors';
import {
  getProjectRootForConfig,
  isInitialized,
  readConfig,
  readLock,
  writeConfig,
  writeLock
} from '../config.js';

function parseBooleanSetting(value) {
  const normalized = String(value).trim().toLowerCase();
  if (['on', 'true', 'yes', 'tak', '1'].includes(normalized)) return true;
  if (['off', 'false', 'no', 'nie', '0'].includes(normalized)) return false;
  throw new Error('Wartość --beta musi być jedną z: on, off');
}

export async function configCommand(options = {}) {
  if (!(await isInitialized())) {
    throw new Error('Nie znaleziono projektu MCPM. Użyj "mcpm use <projekt>" albo "mcpm init"');
  }

  const config = await readConfig();
  const projectRoot = getProjectRootForConfig(config);
  const lock = await readLock(projectRoot);

  if (options.beta === undefined) {
    console.log(pc.bold('Konfiguracja bieżącego projektu MCPM:'));
    console.log(`  Projekt:   ${pc.cyan(projectRoot)}`);
    console.log(`  Minecraft: ${pc.cyan(config.minecraftVersion)}`);
    console.log(`  Loader:    ${pc.cyan(config.loader)}`);
    console.log(`  Beta:      ${config.allowBeta ? pc.green('on') : pc.yellow('off')}`);
    return config;
  }

  const allowBeta = parseBooleanSetting(options.beta);
  const nextConfig = { ...config, allowBeta };
  const nextLock = { ...lock, allowBeta };

  try {
    await writeConfig(nextConfig, projectRoot);
    await writeLock(nextLock, projectRoot);
  } catch (error) {
    try {
      await writeConfig(config, projectRoot);
      await writeLock(lock, projectRoot);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }

  console.log(pc.green(
    `Wersje beta dla projektu ${pc.bold(projectRoot)}: ${allowBeta ? 'włączone' : 'wyłączone'}.`
  ));
  return nextConfig;
}
