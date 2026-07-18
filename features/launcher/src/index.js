import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  createMinecraftSession,
  DEFAULT_MICROSOFT_CLIENT_ID,
  renewMinecraftSession
} from './auth.js';
import { clearSession, readSession, saveSession } from './secure-storage.js';

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
  const session = await readSession(api.getStateDirectory());
  console.log('MCPM Launcher - diagnostyka:');
  console.log(`  Projekt:    ${status.projectRoot}`);
  console.log(`  Minecraft:  ${status.config.minecraftVersion}`);
  console.log(`  Loader:     ${status.config.loader}`);
  console.log(`  Game dir:   ${status.gameDirectory}`);
  console.log(`  Mods:       ${status.installedMods}`);
  console.log(`  Java:       ${status.java.available ? status.java.version : 'nie znaleziono'}`);
  console.log(`  Runtime:    ${status.runtimeInstalled ? 'gotowy' : 'niezainstalowany'}`);
  console.log(`  Runtime dir: ${status.runtimeDirectory}`);
  console.log(`  Microsoft:  ${session ? `zalogowano jako ${session.profile.name}` : 'niezalogowany'}`);
  return status;
}

function getClientId() {
  return process.env.MCPM_MICROSOFT_CLIENT_ID || DEFAULT_MICROSOFT_CLIENT_ID;
}

async function launcherLoginCommand(api) {
  const stateDirectory = api.getStateDirectory();
  const existing = await readSession(stateDirectory);
  if (existing) {
    console.log(`Zapisane konto: ${existing.profile.name}`);
    console.log('Kontynuowanie zastąpi bieżącą sesję po pomyślnym zalogowaniu.');
  }

  const session = await createMinecraftSession({
    clientId: getClientId(),
    onDeviceCode(deviceCode) {
      console.log('\nZaloguj się do konta Microsoft posiadającego Minecraft: Java Edition:');
      console.log(`  Adres: ${deviceCode.verification_uri || deviceCode.verification_uri_complete}`);
      console.log(`  Kod:   ${deviceCode.user_code}`);
      console.log('\nOczekiwanie na potwierdzenie w przeglądarce...');
    }
  });
  await saveSession(stateDirectory, session);
  console.log(`\nZalogowano jako ${session.profile.name} (${session.profile.id}).`);
  return session;
}

async function launcherAccountCommand(api, options = {}) {
  const stateDirectory = api.getStateDirectory();
  let session = await readSession(stateDirectory);
  if (!session) {
    throw new Error('Nie jesteś zalogowany. Użyj "mcpm launcher login".');
  }

  const expiresAt = Date.parse(session.minecraft?.expiresAt || '');
  if (options.refresh || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
    console.log('Odświeżanie sesji Minecraft...');
    session = await renewMinecraftSession(session, { clientId: getClientId() });
    await saveSession(stateDirectory, session);
  }

  console.log('Konto Minecraft:');
  console.log(`  Nazwa:      ${session.profile.name}`);
  console.log(`  UUID:       ${session.profile.id}`);
  console.log(`  Sesja ważna do: ${session.minecraft.expiresAt}`);
  return session;
}

async function launcherLogoutCommand(api) {
  const removed = await clearSession(api.getStateDirectory());
  console.log(removed ? 'Wylogowano z konta Minecraft.' : 'Nie było zapisanej sesji Minecraft.');
  return removed;
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

  launcher
    .command('login')
    .description('Zaloguj się do Minecraft przez kod urządzenia Microsoft')
    .action(() => launcherLoginCommand(api));

  launcher
    .command('account')
    .description('Wyświetl zapisane konto Minecraft')
    .option('--refresh', 'Wymuś odświeżenie sesji i ponowne sprawdzenie konta')
    .action(options => launcherAccountCommand(api, options));

  launcher
    .command('logout')
    .description('Usuń bezpiecznie zapisaną sesję Minecraft')
    .action(() => launcherLogoutCommand(api));
}
