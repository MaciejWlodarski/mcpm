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
  console.log('MCPM Launcher - diagnostics:');
  console.log(`  Project:    ${status.projectRoot}`);
  console.log(`  Minecraft:  ${status.config.minecraftVersion}`);
  console.log(`  Loader:     ${status.config.loader}`);
  console.log(`  Game dir:   ${status.gameDirectory}`);
  console.log(`  Mods:       ${status.installedMods}`);
  console.log(`  Java:       ${status.java.available ? status.java.version : 'not found'}`);
  console.log(`  Runtime:    ${status.runtimeInstalled ? 'ready' : 'not installed'}`);
  console.log(`  Runtime dir: ${status.runtimeDirectory}`);
  console.log(`  Microsoft:  ${session ? `signed in as ${session.profile.name}` : 'not signed in'}`);
  return status;
}

function getClientId() {
  return process.env.MCPM_MICROSOFT_CLIENT_ID || DEFAULT_MICROSOFT_CLIENT_ID;
}

async function launcherLoginCommand(api) {
  const stateDirectory = api.getStateDirectory();
  const existing = await readSession(stateDirectory);
  if (existing) {
    console.log(`Saved account: ${existing.profile.name}`);
    console.log('Continuing will replace the current session after a successful sign-in.');
  }

  const session = await createMinecraftSession({
    clientId: getClientId(),
    onDeviceCode(deviceCode) {
      console.log('\nSign in with the Microsoft account that owns Minecraft: Java Edition:');
      console.log(`  URL:  ${deviceCode.verification_uri || deviceCode.verification_uri_complete}`);
      console.log(`  Code: ${deviceCode.user_code}`);
      console.log('\nWaiting for confirmation in your browser...');
    }
  });
  await saveSession(stateDirectory, session);
  console.log(`\nSigned in as ${session.profile.name} (${session.profile.id}).`);
  return session;
}

async function launcherAccountCommand(api, options = {}) {
  const stateDirectory = api.getStateDirectory();
  let session = await readSession(stateDirectory);
  if (!session) {
    throw new Error('You are not signed in. Run "mcpm launcher login".');
  }

  const expiresAt = Date.parse(session.minecraft?.expiresAt || '');
  if (options.refresh || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
    console.log('Refreshing the Minecraft session...');
    session = await renewMinecraftSession(session, { clientId: getClientId() });
    await saveSession(stateDirectory, session);
  }

  console.log('Minecraft account:');
  console.log(`  Name:       ${session.profile.name}`);
  console.log(`  UUID:       ${session.profile.id}`);
  console.log(`  Session expires: ${session.minecraft.expiresAt}`);
  return session;
}

async function launcherLogoutCommand(api) {
  const removed = await clearSession(api.getStateDirectory());
  console.log(removed ? 'Signed out of the Minecraft account.' : 'No saved Minecraft session was found.');
  return removed;
}

export async function registerFeature({ program, api }) {
  if (api.version !== 1) {
    throw new Error(`Unsupported MCPM Feature API version: ${api.version}`);
  }

  const launcher = program
    .command('launcher')
    .description('Diagnostics and configuration for the optional Minecraft launcher');

  launcher
    .command('status')
    .description('Check whether the active project is ready for direct launching')
    .action(() => launcherStatusCommand(api));

  launcher
    .command('login')
    .description('Sign in to Minecraft with a Microsoft device code')
    .action(() => launcherLoginCommand(api));

  launcher
    .command('account')
    .description('Display the saved Minecraft account')
    .option('--refresh', 'Force a session refresh and verify the account again')
    .action(options => launcherAccountCommand(api, options));

  launcher
    .command('logout')
    .description('Remove the securely saved Minecraft session')
    .action(() => launcherLogoutCommand(api));
}
