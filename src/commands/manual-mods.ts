import fs from 'fs/promises';
import pc from 'picocolors';
import { getProjectRootForConfig, isInitialized, requireConfig, readLock, resolveModsDir } from '../config.js';
import { resolveProjectReference } from '../projects.js';
import { copyManualMod } from '../manual-mods.js';
import { openDirectory } from '../open-directory.js';

export async function addFileCommand(source: string) {
  if (!(await isInitialized())) {
    throw new Error('No MCPM project found. Use "mcpm use <project>" or "mcpm init"');
  }
  const config = await requireConfig();
  const projectRoot = getProjectRootForConfig(config)!;
  const lock = await readLock(projectRoot);
  const result = await copyManualMod(source, resolveModsDir(config, projectRoot), lock);
  console.log(pc.green(`Added ${result.filename} (manual, not managed by MCPM).`));
  console.log(`  File: ${result.path}`);
  return result;
}

export async function openModsCommand(reference: string | null = null, services: { openDirectory?: typeof openDirectory } = {}) {
  const projectRoot = await resolveProjectReference(reference);
  const config = await requireConfig(projectRoot);
  if (!config) throw new Error(`No MCPM project found at ${projectRoot}.`);
  const modsDirectory = resolveModsDir(config, projectRoot);
  await fs.mkdir(modsDirectory, { recursive: true });
  await (services.openDirectory || openDirectory)(modsDirectory);
  console.log(pc.green(`Opening mods folder: ${modsDirectory}`));
  return modsDirectory;
}
