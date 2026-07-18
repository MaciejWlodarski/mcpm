import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const CONFIG_FILENAME = 'mcpm.json';
const LOCK_FILENAME = 'mcpm-lock.json';

export function getConfigPath() {
  return path.join(process.cwd(), CONFIG_FILENAME);
}

export function getLockPath() {
  return path.join(process.cwd(), LOCK_FILENAME);
}

export async function isInitialized() {
  try {
    await fs.access(getConfigPath());
    return true;
  } catch {
    return false;
  }
}

export async function readConfig() {
  try {
    const data = await fs.readFile(getConfigPath(), 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read config file: ${err.message}`);
  }
}

export async function writeConfig(config) {
  await writeJsonAtomically(getConfigPath(), config, 'config file');
}

export async function readLock() {
  try {
    const data = await fs.readFile(getLockPath(), 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Return a default empty lockfile structure
      return {
        minecraftVersion: '',
        loader: '',
        installed: {}
      };
    }
    throw new Error(`Failed to read lockfile: ${err.message}`);
  }
}

export async function writeLock(lock) {
  await writeJsonAtomically(getLockPath(), lock, 'lockfile');
}

async function writeJsonAtomically(filePath, value, label) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    const data = JSON.stringify(value, null, 2);
    await fs.writeFile(temporaryPath, data, 'utf-8');
    await fs.rename(temporaryPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') err.cleanupError ||= cleanupError;
    }
    throw new Error(`Failed to write ${label}: ${err.message}`, { cause: err });
  }
}
