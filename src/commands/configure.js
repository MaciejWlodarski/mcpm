import pc from 'picocolors';
import path from 'path';
import {
  getProjectRootForConfig,
  isInitialized,
  readConfig,
  readLock,
  resolveModsDir,
  writeConfig,
  writeLock
} from '../config.js';

function parseBooleanSetting(value) {
  const normalized = String(value).trim().toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(normalized)) return true;
  if (['off', 'false', 'no', '0'].includes(normalized)) return false;
  throw new Error('The --beta value must be one of: on, off');
}

function parseMemory(value) {
  const normalized = String(value).trim().toUpperCase();
  if (!/^\d+[MG]$/.test(normalized)) {
    throw new Error('The --memory value must look like 4G or 4096M.');
  }
  if (memoryInBytes(normalized) < 256 * 1024 ** 2) {
    throw new Error('The --memory value must be at least 256M.');
  }
  return normalized;
}

function memoryInBytes(value) {
  const match = String(value || '').trim().toUpperCase().match(/^(\d+)([MG])$/);
  if (!match) return null;
  return Number(match[1]) * (match[2] === 'G' ? 1024 ** 3 : 1024 ** 2);
}

function pathsOverlap(left, right) {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative));
}

function parseResolution(value) {
  const match = String(value).trim().match(/^(\d+)x(\d+)$/i);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!match || width < 320 || height < 240) {
    throw new Error('The --resolution value must look like 1280x720 and be at least 320x240.');
  }
  return { width, height };
}

export async function configCommand(options = {}) {
  if (!(await isInitialized())) {
    throw new Error('No MCPM project found. Use "mcpm use <project>" or "mcpm init"');
  }

  const config = await readConfig();
  const projectRoot = getProjectRootForConfig(config);
  const lock = await readLock(projectRoot);

  const hasChanges = ['beta', 'java', 'memory', 'resolution', 'gameDir']
    .some(name => options[name] !== undefined);
  if (!hasChanges) {
    console.log(pc.bold('Current MCPM project configuration:'));
    console.log(`  Project:   ${pc.cyan(projectRoot)}`);
    console.log(`  Minecraft: ${pc.cyan(config.minecraftVersion)}`);
    console.log(`  Loader:    ${pc.cyan(config.loader)}`);
    console.log(`  Beta:      ${config.allowBeta ? pc.green('on') : pc.yellow('off')}`);
    console.log(`  Game dir:  ${pc.cyan(config.gameDir || '.')}`);
    console.log(`  Java:      ${pc.cyan(config.launcher?.javaPath || 'automatic')}`);
    console.log(`  Memory:    ${pc.cyan(config.launcher?.memory?.max || '4G')}`);
    const resolution = config.launcher?.resolution || { width: 1280, height: 720 };
    console.log(`  Resolution: ${pc.cyan(`${resolution.width}x${resolution.height}`)}`);
    return config;
  }

  const nextConfig = structuredClone(config);
  const nextLock = structuredClone(lock);
  nextConfig.launcher ||= {};
  if (options.beta !== undefined) {
    const allowBeta = parseBooleanSetting(options.beta);
    nextConfig.allowBeta = allowBeta;
    nextLock.allowBeta = allowBeta;
  }
  if (options.java !== undefined) {
    if (String(options.java).toLowerCase() === 'auto') delete nextConfig.launcher.javaPath;
    else nextConfig.launcher.javaPath = path.resolve(projectRoot, options.java);
  }
  if (options.memory !== undefined) {
    nextConfig.launcher.memory ||= { min: '512M' };
    nextConfig.launcher.memory.max = parseMemory(options.memory);
    const minimum = memoryInBytes(nextConfig.launcher.memory.min || '512M');
    if (minimum !== null && memoryInBytes(nextConfig.launcher.memory.max) < minimum) {
      throw new Error(
        `Maximum memory (${nextConfig.launcher.memory.max}) cannot be lower than minimum memory ` +
        `(${nextConfig.launcher.memory.min || '512M'}).`
      );
    }
  }
  if (options.resolution !== undefined) {
    nextConfig.launcher.resolution = parseResolution(options.resolution);
  }
  if (options.gameDir !== undefined) {
    if (!String(options.gameDir).trim()) throw new Error('The --game-dir value cannot be empty.');
    nextConfig.gameDir = options.gameDir;
  }

  const gameDirectory = path.resolve(projectRoot, nextConfig.gameDir || '.');
  const expectedModsDirectory = path.join(gameDirectory, 'mods');
  const actualModsDirectory = resolveModsDir(nextConfig, projectRoot);
  if (path.resolve(expectedModsDirectory) !== path.resolve(actualModsDirectory) &&
      (pathsOverlap(expectedModsDirectory, actualModsDirectory) ||
       pathsOverlap(actualModsDirectory, expectedModsDirectory))) {
    throw new Error('The game directory and managed mods directory cannot overlap recursively.');
  }

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

  console.log(pc.green(`Updated launch profile settings for ${pc.bold(projectRoot)}.`));
  return nextConfig;
}
