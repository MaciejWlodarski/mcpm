import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { resolveProjectRoot } from './projects.js';

const CONFIG_FILENAME = 'mcpm.json';
const LOCK_FILENAME = 'mcpm-lock.json';
const configRoots = new WeakMap();

export function getConfigPath(projectRoot = process.cwd()) {
  return path.join(path.resolve(projectRoot), CONFIG_FILENAME);
}

export function getLockPath(projectRoot = process.cwd()) {
  return path.join(path.resolve(projectRoot), LOCK_FILENAME);
}

async function getOperationRoot(projectRoot, config = null) {
  if (projectRoot) return path.resolve(projectRoot);
  if (config && configRoots.has(config)) return configRoots.get(config);
  return resolveProjectRoot();
}

export function getProjectRootForConfig(config) {
  return configRoots.get(config) || null;
}

export function resolveModsDir(config, projectRoot = getProjectRootForConfig(config)) {
  const root = projectRoot || process.cwd();
  return path.resolve(root, config.modsDir);
}

export async function isInitialized(projectRoot = null) {
  try {
    const root = await getOperationRoot(projectRoot);
    await fs.access(getConfigPath(root));
    return true;
  } catch {
    return false;
  }
}

export async function readConfig(projectRoot = null) {
  const root = await getOperationRoot(projectRoot);
  try {
    const data = await fs.readFile(getConfigPath(root), 'utf-8');
    const config = JSON.parse(data);
    configRoots.set(config, root);
    return config;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to read config file: ${err.message}`, { cause: err });
  }
}

export async function writeConfig(config, projectRoot = null) {
  const root = await getOperationRoot(projectRoot, config);
  await writeJsonAtomically(getConfigPath(root), config, 'config file');
  configRoots.set(config, root);
}

export async function readLock(projectRoot = null) {
  const root = await getOperationRoot(projectRoot);
  try {
    const data = await fs.readFile(getLockPath(root), 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { minecraftVersion: '', loader: '', installed: {} };
    }
    throw new Error(`Failed to read lockfile: ${err.message}`, { cause: err });
  }
}

export async function writeLock(lock, projectRoot = null) {
  const root = await getOperationRoot(projectRoot);
  await writeJsonAtomically(getLockPath(root), lock, 'lockfile');
}

async function writeJsonAtomically(filePath, value, label) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
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
