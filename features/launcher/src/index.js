import fs from 'fs/promises';
import path from 'path';
import {
  createMinecraftSession,
  DEFAULT_MICROSOFT_CLIENT_ID,
  renewMinecraftSession
} from './auth.js';
import { inspectJava } from './java-runtime.js';
import { getLauncherDirectory } from './minecraft-runtime.js';
import { launchMinecraft, prepareProfile } from './launch.js';
import { clearSession, readSession, saveSession } from './secure-storage.js';

function getClientId() {
  return process.env.MCPM_MICROSOFT_CLIENT_ID || DEFAULT_MICROSOFT_CLIENT_ID;
}

function javaCandidate(config, projectRoot) {
  const configured = config.launcher?.javaPath || config.javaPath;
  if (configured) {
    const resolved = path.resolve(projectRoot, configured);
    return /javaw?(\.exe)?$/i.test(path.basename(resolved))
      ? resolved
      : path.join(resolved, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  }
  if (process.env.JAVA_HOME) {
    return path.join(
      process.env.JAVA_HOME,
      'bin',
      process.platform === 'win32' ? 'java.exe' : 'java'
    );
  }
  return 'java';
}

export async function findPreparedRuntime(stateDirectory, config) {
  const versionsDirectory = path.join(getLauncherDirectory(stateDirectory), 'versions');
  try {
    const entries = await fs.readdir(versionsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const marker = JSON.parse(await fs.readFile(
          path.join(versionsDirectory, entry.name, 'runtime.json'),
          'utf8'
        ));
        const loaderMatches = marker.loader === config.loader &&
          (!config.loaderVersion || marker.loaderVersion === config.loaderVersion);
        if (marker.minecraftVersion === config.minecraftVersion && loaderMatches &&
            Array.isArray(marker.requiredFiles) && marker.javaExecutable &&
            marker.assetsDirectory && marker.assetIndexPath) {
          await Promise.all(marker.requiredFiles.map(filePath => fs.access(filePath)));
          const assetIndex = JSON.parse(await fs.readFile(marker.assetIndexPath, 'utf8'));
          for (const object of Object.values(assetIndex.objects || {})) {
            if (!/^[a-f0-9]{40}$/i.test(object.hash)) {
              throw new Error(`Invalid asset hash in ${marker.assetIndexPath}`);
            }
            await fs.access(path.join(
              marker.assetsDirectory,
              'objects',
              object.hash.slice(0, 2),
              object.hash
            ));
          }
          const java = inspectJava(marker.javaExecutable);
          if (!java.available) continue;
          return marker;
        }
      } catch {
        // A partial or corrupt cache entry is not considered prepared.
      }
    }
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function createProgressReporter() {
  const buckets = new Map();
  const labels = {
    java: 'Java runtime',
    libraries: 'Libraries',
    assets: 'Assets'
  };
  return ({ phase, completed, total }) => {
    if (!total) return;
    const bucket = Math.min(10, Math.floor((completed / total) * 10));
    if (buckets.get(phase) === bucket && completed !== total) return;
    buckets.set(phase, bucket);
    const percentage = Math.floor((completed / total) * 100);
    process.stdout.write(`  ${labels[phase] || phase}: ${completed}/${total} (${percentage}%)\n`);
  };
}

async function getLauncherStatus(api, profile = null) {
  const context = await api.getProjectContext(profile);
  const java = inspectJava(javaCandidate(context.config, context.projectRoot));
  const runtime = await findPreparedRuntime(api.getStateDirectory(), context.config);
  const gameDirectory = context.config.gameDir
    ? path.resolve(context.projectRoot, context.config.gameDir)
    : context.projectRoot;
  return {
    ...context,
    java,
    runtime,
    supported: ['vanilla', 'fabric'].includes(context.config.loader),
    gameDirectory,
    installedMods: Object.keys(context.lock.installed || {}).length
  };
}

export async function launcherStatusCommand(api, profile = null, services = {}) {
  const status = await getLauncherStatus(api, profile);
  let session = null;
  let sessionError = null;
  try {
    session = await (services.readSession || readSession)(api.getStateDirectory());
  } catch (error) {
    sessionError = error;
  }
  console.log('MCPM Launcher - diagnostics:');
  console.log(`  Profile:    ${status.projectRoot}`);
  console.log(`  Minecraft:  ${status.config.minecraftVersion}`);
  console.log(`  Loader:     ${status.config.loader}`);
  console.log(`  Game dir:   ${status.gameDirectory}`);
  console.log(`  Mods:       ${status.installedMods}`);
  const javaStatus = status.runtime?.javaMajorVersion
    ? `MCPM runtime Java ${status.runtime.javaMajorVersion} (${status.runtime.javaComponent})`
    : status.java.available
      ? `${status.java.version} (automatic runtime selection is enabled)`
      : 'will be downloaded when needed';
  console.log(`  Java:       ${javaStatus}`);
  const runtimeStatus = !status.supported
    ? `unsupported loader (${status.config.loader})`
    : status.runtime
      ? `ready (${status.runtime.id})`
      : 'not prepared';
  console.log(`  Runtime:    ${runtimeStatus}`);
  const accountStatus = sessionError
    ? `saved session is unreadable (${sessionError.message})`
    : session
      ? `signed in as ${session.profile.name}`
      : 'not signed in';
  console.log(`  Microsoft:  ${accountStatus}`);
  return status;
}

export async function launcherLoginCommand(api, services = {}) {
  const stateDirectory = api.getStateDirectory();
  const readSessionImpl = services.readSession || readSession;
  const createSessionImpl = services.createSession || createMinecraftSession;
  const clearSessionImpl = services.clearSession || clearSession;
  const saveSessionImpl = services.saveSession || saveSession;
  let existing = null;
  try {
    existing = await readSessionImpl(stateDirectory);
  } catch (error) {
    console.warn(`The saved launcher session cannot be read and will be replaced: ${error.message}`);
  }
  if (existing) {
    console.log(`Saved account: ${existing.profile.name}`);
    console.log('Continuing will replace the current session after a successful sign-in.');
  }

  const session = await createSessionImpl({
    clientId: getClientId(),
    onDeviceCode(deviceCode) {
      console.log('\nSign in with the Microsoft account that owns Minecraft: Java Edition:');
      console.log(`  URL:  ${deviceCode.verification_uri || deviceCode.verification_uri_complete}`);
      console.log(`  Code: ${deviceCode.user_code}`);
      console.log('\nWaiting for confirmation in your browser...');
    }
  });
  if (!existing) await clearSessionImpl(stateDirectory);
  await saveSessionImpl(stateDirectory, session);
  console.log(`\nSigned in as ${session.profile.name} (${session.profile.id}).`);
  return session;
}

async function getValidSession(api, options = {}) {
  const stateDirectory = api.getStateDirectory();
  let session = await readSession(stateDirectory);
  if (!session) throw new Error('You are not signed in. Run "mcpm launcher login".');

  const expiresAt = Date.parse(session.minecraft?.expiresAt || '');
  const shouldRefresh = options.refresh || !session.minecraft?.xuid ||
    !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5 * 60_000;
  if (shouldRefresh) {
    console.log('Refreshing the Minecraft session...');
    session = await renewMinecraftSession(session, { clientId: getClientId() });
    await saveSession(stateDirectory, session);
  }
  return session;
}

async function launcherAccountCommand(api, options = {}) {
  const session = await getValidSession(api, options);
  console.log('Minecraft account:');
  console.log(`  Name:            ${session.profile.name}`);
  console.log(`  UUID:            ${session.profile.id}`);
  console.log(`  Session expires: ${session.minecraft.expiresAt}`);
  return session;
}

async function launcherLogoutCommand(api) {
  const removed = await clearSession(api.getStateDirectory());
  console.log(removed ? 'Signed out of the Minecraft account.' : 'No saved Minecraft session was found.');
  return removed;
}

export async function profilesCommand(api) {
  const projects = await api.listProjects();
  if (projects.length === 0) {
    console.log('No MCPM launch profiles are registered. Run "mcpm init" first.');
    return [];
  }
  console.log('MCPM launch profiles:');
  for (const project of projects.sort((left, right) => left.name.localeCompare(right.name))) {
    let context = null;
    let contextError = null;
    if (project.available) {
      try {
        context = await api.getProjectContext(project.name);
      } catch (error) {
        contextError = error;
      }
    }
    const mods = context ? Object.keys(context.lock.installed || {}).length : 0;
    const details = context
      ? `${context.config.minecraftVersion} / ${context.config.loader} / ${mods} mods`
      : contextError
        ? `invalid: ${contextError.message}`
        : 'unavailable';
    console.log(`  ${project.active ? '*' : ' '} ${project.name} - ${details}`);
    console.log(`      ${project.path}`);
  }
  return projects;
}

async function selectProfileCommand(api, profile) {
  const selected = await api.setActiveProject(profile);
  console.log(`Active MCPM launch profile: ${selected.name} (${selected.path})`);
  return selected;
}

async function prepareCommand(api, profile, options = {}) {
  const context = await api.getProjectContext(profile);
  console.log(
    `Preparing ${context.config.minecraftVersion} / ${context.config.loader} profile at ` +
    `${context.projectRoot}...`
  );
  const prepared = await prepareProfile(context, api.getStateDirectory(), {
    ...options,
    onProgress: createProgressReporter()
  });
  console.log(
    `Profile is ready with ${prepared.metadata.loader} ` +
    `${prepared.metadata.loaderVersion || ''} and ${prepared.java.version}.`
  );
  return prepared;
}

async function launchCommand(api, profile, options = {}) {
  const context = await api.getProjectContext(profile);
  const session = options.prepareOnly ? null : await getValidSession(api);
  console.log(
    `${options.prepareOnly ? 'Preparing' : 'Launching'} profile ` +
    `${profile || path.basename(context.projectRoot)} ` +
    `(${context.config.minecraftVersion} / ${context.config.loader}, ` +
    `${Object.keys(context.lock.installed || {}).length} mods)...`
  );
  const result = await launchMinecraft(context, api.getStateDirectory(), session, {
    ...options,
    onProgress: createProgressReporter()
  });

  if (options.prepareOnly) {
    console.log('Profile runtime is ready.');
  } else if (options.dryRun) {
    console.log('Launch command prepared successfully (access token hidden).');
    console.log(`  Java:       ${result.command.executable}`);
    console.log(`  Main class: ${result.metadata.mainClass}`);
    console.log(`  Arguments:  ${result.command.args.length}`);
  } else if (options.detach) {
    console.log(`Minecraft started in the background (PID ${result.processId}).`);
  } else if (result.exitCode !== 0) {
    throw new Error(`Minecraft exited with code ${result.exitCode}.`);
  }
  return result;
}

function addLaunchOptions(command) {
  return command
    .option('--prepare-only', 'Download and prepare the profile without starting Minecraft')
    .option('--dry-run', 'Validate and build the launch command without starting Minecraft')
    .option('--detach', 'Start Minecraft in the background')
    .option('--java <path>', 'Use a specific Java executable or Java home directory')
    .option('--memory <size>', 'Override maximum memory, for example 4G or 4096M')
    .option('--width <pixels>', 'Override window width', Number)
    .option('--height <pixels>', 'Override window height', Number)
    .option('--server <address>', 'Connect to a multiplayer server after launch')
    .option('--no-download-java', 'Do not download the Mojang Java runtime automatically');
}

export async function registerFeature({ program, api }) {
  if (api.version !== 2) {
    throw new Error(`Unsupported MCPM Feature API version: ${api.version}`);
  }
  for (const capability of ['listProjects', 'setActiveProject', 'getProjectContext']) {
    if (typeof api[capability] !== 'function') {
      throw new Error(`MCPM Launcher requires Feature API capability ${capability}.`);
    }
  }

  program
    .command('profiles')
    .description('List MCPM projects as launch profiles')
    .action(() => profilesCommand(api));

  program
    .command('profile <profile>')
    .description('Set the active MCPM launch profile')
    .action(profile => selectProfileCommand(api, profile));

  addLaunchOptions(program
    .command('launch [profile]')
    .description('Prepare and launch Minecraft using an MCPM profile'))
    .action((profile, options) => launchCommand(api, profile, options));

  const launcher = program
    .command('launcher')
    .description('Diagnostics and configuration for the optional Minecraft launcher');

  launcher
    .command('status [profile]')
    .description('Check whether a profile is ready for direct launching')
    .action(profile => launcherStatusCommand(api, profile));

  launcher
    .command('profiles')
    .description('List MCPM projects as launch profiles')
    .action(() => profilesCommand(api));

  launcher
    .command('prepare [profile]')
    .description('Download Minecraft, loader, libraries, assets, and Java for a profile')
    .option('--java <path>', 'Use a specific Java executable or Java home directory')
    .option('--no-download-java', 'Do not download the Mojang Java runtime automatically')
    .action((profile, options) => prepareCommand(api, profile, options));

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
