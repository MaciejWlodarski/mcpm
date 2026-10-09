import pc from 'picocolors';
import {
  getProjectRootForConfig,
  isInitialized,
  requireConfig,
  readLock,
  resolveModsDir
} from '../config.js';
import { findManualMods } from '../manual-mods.js';

/**
 * Lists all installed mods with their versions, installation type, and dependency mappings.
 */
export async function listCommand() {
  if (!(await isInitialized())) {
    throw new Error('No MCPM project found. Use "mcpm use <project>" or "mcpm init"');
  }

  const config = await requireConfig();
  const projectRoot = getProjectRootForConfig(config)!;
  const lock = await readLock(projectRoot);
  const modsDirectory = resolveModsDir(config, projectRoot);
  const manualMods = await findManualMods(modsDirectory, lock);

  const installedCount = Object.keys(lock.installed).length;
  
  console.log(pc.bold('MCPM - Project configuration:'));
  console.log(`  Project:   ${pc.cyan(projectRoot)}`);
  console.log(`  Minecraft: ${pc.cyan(config.minecraftVersion)}`);
  console.log(`  Loader:    ${pc.cyan(config.loader)}`);
  console.log(`  Directory: ${pc.cyan(modsDirectory)}`);
  console.log(`  Managed mods: ${pc.cyan(installedCount)}`);
  console.log(`  Manual mods:  ${pc.yellow(manualMods.length)}\n`);

  if (installedCount === 0 && manualMods.length === 0) {
    console.log(pc.yellow('No mods are installed.'));
    return;
  }

  // Helper to find all mods that depend on a specific mod ID
  const getDependents = (targetId: string) => {
    const dependents = [];
    for (const [id, mod] of Object.entries(lock.installed)) {
      if (mod.dependencies && mod.dependencies.includes(targetId)) {
        dependents.push(mod.title);
      }
    }
    return dependents;
  };

  // Map mods and calculate dependencies/dependents
  const modsList = Object.entries(lock.installed).map(([id, mod]) => ({
    id,
    ...mod,
    dependents: getDependents(id)
  }));

  // Sort: direct installations first, then dependencies, then alphabetically
  modsList.sort((a, b) => {
    if (a.isDependency !== b.isDependency) {
      return a.isDependency ? 1 : -1;
    }
    return a.title.localeCompare(b.title);
  });

  modsList.forEach(mod => {
    const typeLabel = mod.isDependency 
      ? pc.gray('(dependency)')
      : pc.bold(pc.green('(direct)'));
      
    const versionLabel = pc.cyan(`v${mod.version}`);
    
    console.log(`- ${pc.bold(mod.title)} ${pc.yellow(`[${mod.slug}]`)} - ${versionLabel} ${typeLabel}`);
    
    if (mod.isDependency && mod.dependents.length > 0) {
      console.log(`  ${pc.gray('Required by: ')}${pc.yellow(mod.dependents.join(', '))}`);
    } else if (!mod.isDependency && (mod.dependencies || []).length > 0) {
      const depNames = (mod.dependencies || []).map(depId => {
        const depMod = lock.installed[depId];
        return depMod ? depMod.title : depId;
      });
      console.log(`  ${pc.gray('Depends on: ')}${pc.cyan(depNames.join(', '))}`);
    }
  });
  if (manualMods.length > 0) {
    console.log(pc.bold('\nManual mods (not managed by MCPM):'));
    for (const mod of manualMods) {
      console.log(`- ${pc.bold(mod.filename)} ${pc.yellow('(manual, compatibility unknown)')}`);
    }
  }
  console.log();
}
