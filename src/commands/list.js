import pc from 'picocolors';
import {
  getProjectRootForConfig,
  isInitialized,
  readConfig,
  readLock,
  resolveModsDir
} from '../config.js';

/**
 * Lists all installed mods with their versions, installation type, and dependency mappings.
 */
export async function listCommand() {
  if (!(await isInitialized())) {
    throw new Error('Nie znaleziono projektu MCPM. Użyj "mcpm use <projekt>" albo "mcpm init"');
  }

  const config = await readConfig();
  const projectRoot = getProjectRootForConfig(config);
  const lock = await readLock(projectRoot);

  const installedCount = Object.keys(lock.installed).length;
  
  console.log(pc.bold('MCPM - Konfiguracja projektu:'));
  console.log(`  Projekt:   ${pc.cyan(projectRoot)}`);
  console.log(`  Minecraft: ${pc.cyan(config.minecraftVersion)}`);
  console.log(`  Loader:    ${pc.cyan(config.loader)}`);
  console.log(`  Katalog:   ${pc.cyan(resolveModsDir(config, projectRoot))}`);
  console.log(`  Zainstalowane modyfikacje: ${pc.cyan(installedCount)}\n`);

  if (installedCount === 0) {
    console.log(pc.yellow('Brak zainstalowanych modyfikacji.'));
    return;
  }

  // Helper to find all mods that depend on a specific mod ID
  const getDependents = (targetId) => {
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
      ? pc.gray('(zależność)') 
      : pc.bold(pc.green('(bezpośredni)'));
      
    const versionLabel = pc.cyan(`v${mod.version}`);
    
    console.log(`• ${pc.bold(mod.title)} ${pc.yellow(`[${mod.slug}]`)} - ${versionLabel} ${typeLabel}`);
    
    if (mod.isDependency && mod.dependents.length > 0) {
      console.log(`  ${pc.gray('└─ Wymagany przez: ')}${pc.yellow(mod.dependents.join(', '))}`);
    } else if (!mod.isDependency && mod.dependencies.length > 0) {
      const depNames = mod.dependencies.map(depId => {
        const depMod = lock.installed[depId];
        return depMod ? depMod.title : depId;
      });
      console.log(`  ${pc.gray('└─ Zależy od: ')}${pc.cyan(depNames.join(', '))}`);
    }
  });
  console.log();
}
