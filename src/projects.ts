import type { ProjectRegistry } from './types.js';
import { toError } from './errors.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

const CONFIG_FILENAME = 'mcpm.json';
const REGISTRY_FILENAME = 'projects.json';

export function getStateDirectory() {
  return process.env.MCPM_STATE_DIR
    ? path.resolve(process.env.MCPM_STATE_DIR)
    : path.join(os.homedir(), '.mcpm');
}

export function getRegistryPath() {
  return path.join(getStateDirectory(), REGISTRY_FILENAME);
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

async function isProjectRoot(projectRoot: string) {
  return pathExists(path.join(projectRoot, CONFIG_FILENAME));
}

export async function findProjectRoot(startPath = process.cwd()) {
  let current = path.resolve(startPath);

  while (true) {
    if (await isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function readProjectRegistry(): Promise<ProjectRegistry> {
  try {
    const data = JSON.parse(await fs.readFile(getRegistryPath(), 'utf8')) as ProjectRegistry;
    return {
      version: 1,
      active: typeof data.active === 'string' ? data.active : null,
      projects: data.projects && typeof data.projects === 'object' ? data.projects : {}
    };
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code === 'ENOENT') {
      return { version: 1, active: null, projects: {} };
    }
    throw new Error(`Failed to read the MCPM project registry: ${error.message}`, { cause: error });
  }
}

async function writeProjectRegistry(registry: ProjectRegistry) {
  const registryPath = getRegistryPath();
  const temporaryPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(registryPath), { recursive: true });

  try {
    await fs.writeFile(temporaryPath, JSON.stringify(registry, null, 2), 'utf8');
    await fs.rename(temporaryPath, registryPath);
  } catch (errorCause) {
    const error = toError(errorCause);
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupErrorCause) {
      const cleanupError = toError(cleanupErrorCause);
      if (cleanupError.code !== 'ENOENT') error.cleanupError ||= cleanupError;
    }
    throw new Error(`Failed to write the MCPM project registry: ${error.message}`, { cause: error });
  }
}

function createUniqueName(registry: ProjectRegistry, desiredName: string, projectRoot: string) {
  const normalized = desiredName.trim() || path.basename(projectRoot) || 'project';
  if (!registry.projects[normalized] || registry.projects[normalized].path === projectRoot) {
    return normalized;
  }

  let suffix = 2;
  while (registry.projects[`${normalized}-${suffix}`]) suffix += 1;
  return `${normalized}-${suffix}`;
}

export async function registerProject(projectPath: string, options: { name?: string; activate?: boolean } = {}) {
  const root = await findProjectRoot(projectPath);
  if (!root) {
    throw new Error(`Directory ${path.resolve(projectPath)} does not contain an MCPM project`);
  }

  const registry = await readProjectRegistry();
  const existing = Object.entries(registry.projects)
    .find(([, project]) => path.resolve(project.path) === root);
  const name = existing?.[0] || createUniqueName(
    registry,
    options.name || path.basename(root),
    root
  );

  registry.projects[name] = {
    path: root,
    registeredAt: existing?.[1].registeredAt || new Date().toISOString()
  };
  if (options.activate !== false) registry.active = name;
  await writeProjectRegistry(registry);

  return { name, path: root, active: registry.active === name };
}

export async function setActiveProject(reference: string) {
  const registry = await readProjectRegistry();
  const registered = registry.projects[reference];

  if (registered) {
    const root = path.resolve(registered.path);
    if (!(await isProjectRoot(root))) {
      throw new Error(`Registered project "${reference}" no longer exists at ${root}`);
    }
    registry.active = reference;
    await writeProjectRegistry(registry);
    return { name: reference, path: root, active: true };
  }

  return registerProject(path.resolve(reference), { activate: true });
}

export async function forgetProject(reference: string) {
  const registry = await readProjectRegistry();
  const entry: [string, ProjectRegistry['projects'][string]] | undefined = registry.projects[reference]
    ? [reference, registry.projects[reference]]
    : Object.entries(registry.projects)
      .find(([, project]) => path.resolve(project.path) === path.resolve(reference));

  if (!entry) throw new Error(`Project "${reference}" is not registered`);

  const [name, project] = entry;
  delete registry.projects[name];
  if (registry.active === name) registry.active = null;
  await writeProjectRegistry(registry);
  return { name, path: path.resolve(project.path) };
}

export async function listProjects() {
  const registry = await readProjectRegistry();
  return Promise.all(Object.entries(registry.projects).map(async ([name, project]) => ({
    name,
    path: path.resolve(project.path),
    active: registry.active === name,
    available: await isProjectRoot(path.resolve(project.path))
  })));
}

export async function resolveProjectReference(reference?: string | null) {
  if (!reference) return resolveProjectRoot();

  const registry = await readProjectRegistry();
  const registered = registry.projects[reference];
  if (registered) {
    const root = path.resolve(registered.path);
    if (!(await isProjectRoot(root))) {
      throw new Error(`Registered project "${reference}" no longer exists at ${root}`);
    }
    return root;
  }

  const directRoot = await findProjectRoot(path.resolve(reference));
  if (directRoot) return directRoot;
  throw new Error(`MCPM profile "${reference}" was not found.`);
}

export async function resolveProjectRoot() {
  if (process.env.MCPM_PROJECT) {
    const environmentRoot = await findProjectRoot(process.env.MCPM_PROJECT);
    if (environmentRoot) return environmentRoot;
    throw new Error(`MCPM_PROJECT does not point to a valid project: ${process.env.MCPM_PROJECT}`);
  }

  const localRoot = await findProjectRoot();
  if (localRoot) return localRoot;

  const registry = await readProjectRegistry();
  const activeProject = registry.active && registry.projects[registry.active];
  if (activeProject) {
    const activeRoot = path.resolve(activeProject.path);
    if (await isProjectRoot(activeRoot)) return activeRoot;
    throw new Error(
      `Active project "${registry.active}" no longer exists at ${activeRoot}. ` +
      'Select another one with "mcpm use <name-or-path>".'
    );
  }

  throw new Error(
    'No MCPM project is selected. Run "mcpm use <path>" or initialize one with "mcpm init".'
  );
}
