import type { JavaInspection, LaunchMetadata, LaunchOptions, MinecraftRuntime, MinecraftSession, ProfileConfig, ProjectContext } from './types.js';
import { toError } from './errors.js';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { evaluateArguments } from './metadata.js';
import { resolveLaunchMetadata } from './metadata.js';
import { resolveJava } from './java-runtime.js';
import {
  prepareMinecraftRuntime,
  writePreparedRuntimeMarker
} from './minecraft-runtime.js';
import { pathExists } from './downloads.js';

function resolveGameDirectory(context: ProjectContext) {
  return context.config.gameDir
    ? path.resolve(context.projectRoot, context.config.gameDir)
    : context.projectRoot;
}

async function directoryIsEmpty(directory: string) {
  try {
    return (await fs.readdir(directory)).length === 0;
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function isSameOrAncestor(ancestor: string, candidate: string) {
  const relative = path.relative(path.resolve(ancestor), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative));
}

async function ensureModsConnection(gameDirectory: string, modsDirectory: string) {
  const expectedModsDirectory = path.join(gameDirectory, 'mods');
  const actualModsDirectory = path.resolve(modsDirectory);
  await fs.mkdir(gameDirectory, { recursive: true });
  await fs.mkdir(actualModsDirectory, { recursive: true });
  if (path.resolve(expectedModsDirectory) === actualModsDirectory) return;
  if (isSameOrAncestor(actualModsDirectory, expectedModsDirectory) ||
      isSameOrAncestor(expectedModsDirectory, actualModsDirectory)) {
    throw new Error(
      `Cannot connect ${expectedModsDirectory} to ${actualModsDirectory} because the paths overlap.`
    );
  }

  try {
    const stat = await fs.lstat(expectedModsDirectory);
    if (stat.isSymbolicLink()) {
      let existingTarget;
      try {
        existingTarget = await fs.realpath(expectedModsDirectory);
      } catch (errorCause) {
        const error = toError(errorCause);
        if (error.code !== 'ENOENT') throw error;
        await fs.unlink(expectedModsDirectory);
        existingTarget = null;
      }
      const requestedTarget = await fs.realpath(actualModsDirectory);
      if (existingTarget) {
        if (existingTarget === requestedTarget) return;
        throw new Error(
          `The profile mods link points to ${existingTarget}, not ${requestedTarget}.`
        );
      }
    } else {
      if (!stat.isDirectory() || !(await directoryIsEmpty(expectedModsDirectory))) {
        throw new Error(
          `Cannot connect MCPM mods to the game profile because ${expectedModsDirectory} ` +
          'already contains files.'
        );
      }
      await fs.rmdir(expectedModsDirectory);
    }
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.symlink(
    actualModsDirectory,
    expectedModsDirectory,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
}

export async function ensureProfileDirectories(context: ProjectContext) {
  const gameDirectory = resolveGameDirectory(context);
  await fs.mkdir(gameDirectory, { recursive: true });
  for (const directory of ['config', 'logs', 'resourcepacks', 'saves', 'screenshots']) {
    await fs.mkdir(path.join(gameDirectory, directory), { recursive: true });
  }
  await ensureModsConnection(gameDirectory, context.modsDir);
  return gameDirectory;
}

function normalizeMemory(value: string | undefined, fallback: string | null) {
  const selected = value || fallback;
  if (!selected) return null;
  const result = String(selected).trim().toUpperCase();
  if (!/^\d+[MG]$/.test(result)) {
    throw new Error(`Invalid memory value "${value}". Use a value such as 4G or 4096M.`);
  }
  return result;
}

function memoryInBytes(value: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d+)([MG])$/);
  const multiplier = match?.[2] === 'G' ? 1024 ** 3 : 1024 ** 2;
  return match ? Number(match[1]) * multiplier : null;
}

function replaceVariables(value: string, variables: Record<string, string | number>) {
  return value.replace(/\$\{([^}]+)\}/g, (match, name) => {
    if (!(name in variables)) throw new Error(`Missing launch variable: ${name}`);
    return String(variables[name]);
  });
}

function splitLegacyArguments(value: string) {
  const argumentsList = [];
  const expression = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = expression.exec(value))) {
    argumentsList.push(match[1] ?? match[2] ?? match[3]);
  }
  return argumentsList;
}

function getResolution(config: ProfileConfig, options: LaunchOptions) {
  const configured = config.launcher?.resolution || {};
  const width = Number(options.width || configured.width || 1280);
  const height = Number(options.height || configured.height || 720);
  if (!Number.isInteger(width) || width < 320 || !Number.isInteger(height) || height < 240) {
    throw new Error('Launch resolution must be at least 320x240.');
  }
  return { width, height };
}

export function buildLaunchCommand(metadata: LaunchMetadata, runtime: MinecraftRuntime, java: JavaInspection, context: ProjectContext, session: MinecraftSession | null, options: LaunchOptions = {}) {
  if (!session?.minecraft?.accessToken || !session?.profile?.id || !session?.profile?.name) {
    throw new Error('A valid Minecraft account session is required to launch the game.');
  }
  const resolution = getResolution(context.config, options);
  const features = {
    has_custom_resolution: true,
    is_demo_user: false,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  };
  const gameDirectory = resolveGameDirectory(context);
  const variables = {
    auth_player_name: session.profile.name,
    version_name: metadata.id,
    game_directory: gameDirectory,
    assets_root: runtime.assetsDirectory,
    assets_index_name: runtime.assetIndexId,
    auth_uuid: session.profile.id,
    auth_access_token: session.minecraft.accessToken,
    auth_session: `token:${session.minecraft.accessToken}:${session.profile.id}`,
    clientid: session.clientId || '',
    auth_xuid: session.minecraft.xuid || '',
    user_type: 'msa',
    user_properties: '{}',
    version_type: metadata.profile.type || metadata.vanilla.type || 'release',
    resolution_width: resolution.width,
    resolution_height: resolution.height,
    natives_directory: runtime.nativesDirectory,
    launcher_name: 'MCPM',
    launcher_version: '0.3.0',
    classpath: runtime.classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: path.join(runtime.launcherDirectory, 'libraries')
  };
  const argumentOptions = { features };
  const defaultJvm = evaluateArguments(metadata.arguments?.['default-user-jvm'], argumentOptions);
  const manifestJvm = evaluateArguments(metadata.arguments?.jvm, argumentOptions);
  const configuredJvm = Array.isArray(context.config.launcher?.jvmArgs)
    ? context.config.launcher.jvmArgs
    : [];
  const maximumMemory = normalizeMemory(
    options.memory || context.config.launcher?.memory?.max,
    defaultJvm.some(value => value.startsWith('-Xmx')) ? null : '4G'
  );
  const minimumMemory = normalizeMemory(
    context.config.launcher?.memory?.min,
    defaultJvm.some(value => value.startsWith('-Xms')) ? null : '512M'
  );
  const maximumBytes = memoryInBytes(maximumMemory);
  const minimumBytes = memoryInBytes(minimumMemory);
  if (maximumBytes !== null && maximumBytes < 256 * 1024 ** 2) {
    throw new Error('Maximum memory must be at least 256M.');
  }
  if (maximumBytes !== null && minimumBytes !== null && maximumBytes < minimumBytes) {
    throw new Error(`Maximum memory (${maximumMemory}) cannot be lower than minimum memory (${minimumMemory}).`);
  }

  let jvmArguments = [...manifestJvm, ...defaultJvm, ...configuredJvm]
    .filter(value => typeof value === 'string');
  if (maximumMemory) {
    jvmArguments = jvmArguments.filter(value => !value.startsWith('-Xmx'));
    jvmArguments.push(`-Xmx${maximumMemory}`);
  }
  if (minimumMemory) {
    jvmArguments = jvmArguments.filter(value => !value.startsWith('-Xms'));
    jvmArguments.push(`-Xms${minimumMemory}`);
  }
  if (runtime.logging.argument) jvmArguments.push(runtime.logging.argument);
  jvmArguments = jvmArguments.map(value => replaceVariables(value, variables));

  let gameArguments = metadata.arguments
    ? evaluateArguments(metadata.arguments.game, argumentOptions)
    : splitLegacyArguments(metadata.minecraftArguments || '');
  gameArguments = gameArguments.map(value => replaceVariables(value, variables));
  if (options.server) gameArguments.push('--server', options.server);

  return {
    executable: java.executable,
    args: [...jvmArguments, metadata.mainClass, ...gameArguments],
    cwd: gameDirectory,
    profile: {
      minecraftVersion: context.config.minecraftVersion,
      loader: metadata.loader,
      loaderVersion: metadata.loaderVersion,
      account: session.profile.name,
      java: java.version,
      gameDirectory
    }
  };
}

export async function prepareProfile(context: ProjectContext, stateDirectory: string, options: LaunchOptions = {}) {
  if (!['vanilla', 'fabric'].includes(context.config.loader)) {
    throw new Error(
      `Direct launching currently supports vanilla and Fabric profiles; received loader ` +
      `${context.config.loader}.`
    );
  }
  const gameDirectory = await ensureProfileDirectories(context);
  const metadata = await resolveLaunchMetadata(context.config, options);
  const [runtime, java] = await Promise.all([
    prepareMinecraftRuntime(metadata, stateDirectory, gameDirectory, options),
    resolveJava(metadata.vanilla, context.config, stateDirectory, {
      ...options,
      projectRoot: context.projectRoot
    })
  ]);
  await writePreparedRuntimeMarker(runtime, java);
  return { metadata, runtime, java, gameDirectory };
}

export async function launchMinecraft(context: ProjectContext, stateDirectory: string, session: MinecraftSession | null, options: LaunchOptions = {}): Promise<LaunchResult> {
  const prepared = await prepareProfile(context, stateDirectory, options);
  if (options.prepareOnly) return { ...prepared, mode: 'prepared', command: null, exitCode: null };
  const command = buildLaunchCommand(
    prepared.metadata,
    prepared.runtime,
    prepared.java,
    context,
    session,
    options
  );
  if (options.dryRun) return { ...prepared, mode: 'dry-run', command, exitCode: null };

  if (!(await pathExists(command.executable))) {
    const systemJava = command.executable === 'java';
    if (!systemJava) throw new Error(`Java executable was not found: ${command.executable}`);
  }
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: process.env,
    stdio: options.detach ? 'ignore' : 'inherit',
    detached: Boolean(options.detach),
    windowsHide: false,
    shell: false
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  if (options.detach) {
    child.unref();
    return { ...prepared, mode: 'detached', command, processId: child.pid, exitCode: null };
  }

  const exitCode = await new Promise<number>(resolve => {
    child.on('exit', code => resolve(code ?? 1));
  });
  return { ...prepared, mode: 'exited', command, processId: child.pid, exitCode };
}

export type PreparedProfile = Awaited<ReturnType<typeof prepareProfile>>;
export type LaunchCommand = ReturnType<typeof buildLaunchCommand>;
export type LaunchResult = PreparedProfile & (
  | { mode: 'prepared'; command: null; exitCode: null }
  | { mode: 'dry-run'; command: LaunchCommand; exitCode: null }
  | { mode: 'detached'; command: LaunchCommand; processId?: number; exitCode: null }
  | { mode: 'exited'; command: LaunchCommand; processId?: number; exitCode: number }
);
