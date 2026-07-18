import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function inspectJava(config) {
  const candidates = [];
  if (config.javaPath) candidates.push(path.resolve(config.javaPath));
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(
      process.env.JAVA_HOME,
      'bin',
      process.platform === 'win32' ? 'java.exe' : 'java'
    ));
  }
  candidates.push('java');

  for (const executable of [...new Set(candidates)]) {
    const result = spawnSync(executable, ['-version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) {
      const version = `${result.stderr || ''}${result.stdout || ''}`.split(/\r?\n/)[0].trim();
      return { available: true, executable, version };
    }
  }

  return { available: false, executable: null, version: null };
}

async function getLauncherStatus(api) {
  const context = await api.getProjectContext();
  const java = inspectJava(context.config);
  const runtimeDirectory = path.join(
    api.getStateDirectory(),
    'features',
    'launcher-runtime',
    context.config.minecraftVersion,
    context.config.loader
  );
  const gameDirectory = context.config.gameDir
    ? path.resolve(context.projectRoot, context.config.gameDir)
    : context.projectRoot;

  return {
    ...context,
    java,
    runtimeDirectory,
    runtimeInstalled: await pathExists(path.join(runtimeDirectory, 'runtime.json')),
    gameDirectory,
    installedMods: Object.keys(context.lock.installed || {}).length
  };
}

async function launcherStatusCommand(api) {
  const status = await getLauncherStatus(api);
  console.log('MCPM Launcher - diagnostyka:');
  console.log(`  Projekt:    ${status.projectRoot}`);
  console.log(`  Minecraft:  ${status.config.minecraftVersion}`);
  console.log(`  Loader:     ${status.config.loader}`);
  console.log(`  Game dir:   ${status.gameDirectory}`);
  console.log(`  Mods:       ${status.installedMods}`);
  console.log(`  Java:       ${status.java.available ? status.java.version : 'nie znaleziono'}`);
  console.log(`  Runtime:    ${status.runtimeInstalled ? 'gotowy' : 'niezainstalowany'}`);
  console.log(`  Runtime dir: ${status.runtimeDirectory}`);
  console.log('  Microsoft:  logowanie niezaimplementowane (następny etap)');
  return status;
}

export async function registerFeature({ program, api }) {
  if (api.version !== 1) {
    throw new Error(`Nieobsługiwana wersja MCPM Feature API: ${api.version}`);
  }

  const launcher = program
    .command('launcher')
    .description('Diagnostyka i konfiguracja opcjonalnego launchera Minecraft');

  launcher
    .command('status')
    .description('Sprawdź gotowość aktywnego projektu do bezpośredniego uruchamiania')
    .action(() => launcherStatusCommand(api));
}
