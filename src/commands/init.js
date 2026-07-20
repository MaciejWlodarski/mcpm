import { intro, outro, select, text, confirm, isCancel, spinner } from '@clack/prompts';
import pc from 'picocolors';
import path from 'path';
import fs from 'fs/promises';
import { getGameVersions } from '../api.js';
import { getConfigPath, getLockPath, writeConfig, writeLock } from '../config.js';
import { registerProject } from '../projects.js';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function persistInitializedProject(
  projectRoot,
  config,
  lock,
  profileName,
  services = {}
) {
  const writeConfigImpl = services.writeConfig || writeConfig;
  const writeLockImpl = services.writeLock || writeLock;
  const registerProjectImpl = services.registerProject || registerProject;
  const rootExisted = await exists(projectRoot);
  const configPath = getConfigPath(projectRoot);
  const lockPath = getLockPath(projectRoot);
  if (await exists(configPath) || await exists(lockPath)) {
    throw new Error(`MCPM configuration files already exist at ${projectRoot}.`);
  }

  let configWritten = false;
  let lockWritten = false;
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    await writeConfigImpl(config, projectRoot);
    configWritten = true;
    await writeLockImpl(lock, projectRoot);
    lockWritten = true;
    return await registerProjectImpl(projectRoot, { name: profileName });
  } catch (error) {
    if (lockWritten) await fs.rm(lockPath, { force: true }).catch(() => {});
    if (configWritten) await fs.rm(configPath, { force: true }).catch(() => {});
    if (!rootExisted) await fs.rmdir(projectRoot).catch(() => {});
    throw error;
  }
}

/**
 * Executes the `mcpm init` command to interactively create configuration files.
 */
export async function initCommand(projectPath = '.') {
  const projectRoot = path.resolve(projectPath);
  if (await exists(getConfigPath(projectRoot)) || await exists(getLockPath(projectRoot))) {
    throw new Error(`An MCPM profile already exists at ${projectRoot}.`);
  }

  intro(pc.bgCyan(pc.black(' MCPM - Project setup ')));
  console.log(pc.dim(`Profile directory: ${projectRoot}`));

  let mcVersions = [];
  const s = spinner();
  s.start('Fetching Minecraft versions from Modrinth...');
  try {
    const rawVersions = await getGameVersions();
    // Filter to releases, sort by date descending
    mcVersions = rawVersions
      .filter(v => v.version_type === 'release')
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(v => v.version);
    s.stop('Minecraft versions fetched.');
  } catch (err) {
    s.stop('Failed to fetch versions from Modrinth (using offline mode).');
  }

  // Build options for selecting Minecraft version
  let mcVersionOptions = [];
  if (mcVersions.length > 0) {
    // Take the top 12 versions
    mcVersionOptions = mcVersions.slice(0, 12).map(v => ({ value: v, label: v }));
    mcVersionOptions.push({ value: 'custom', label: 'Enter another version...' });
  }

  let mcVersion;
  if (mcVersionOptions.length > 0) {
    mcVersion = await select({
      message: 'Select a Minecraft version:',
      options: mcVersionOptions
    });
    
    if (isCancel(mcVersion)) {
      outro(pc.yellow('Setup cancelled.'));
      process.exit(0);
    }
    
    if (mcVersion === 'custom') {
      mcVersion = await text({
        message: 'Enter the Minecraft version:',
        placeholder: '1.20.1',
        validate(value) {
          if (!value) return 'The version cannot be empty!';
        }
      });
      if (isCancel(mcVersion)) {
        outro(pc.yellow('Setup cancelled.'));
        process.exit(0);
      }
    }
  } else {
    // Fallback if API failed or empty
    mcVersion = await text({
      message: 'Enter the Minecraft version (for example, 1.20.1):',
      placeholder: '1.20.1',
      validate(value) {
        if (!value) return 'The version cannot be empty!';
      }
    });
    if (isCancel(mcVersion)) {
      outro(pc.yellow('Setup cancelled.'));
      process.exit(0);
    }
  }

  const loader = await select({
    message: 'Select a mod loader:',
    options: [
      { value: 'fabric', label: 'Fabric' },
      { value: 'forge', label: 'Forge' },
      { value: 'neoforge', label: 'NeoForge' },
      { value: 'quilt', label: 'Quilt' }
    ]
  });

  if (isCancel(loader)) {
    outro(pc.yellow('Setup cancelled.'));
    process.exit(0);
  }

  const modsDir = await text({
    message: 'Path to the mods directory:',
    placeholder: './mods',
    initialValue: './mods',
    validate(value) {
      if (!value) return 'The path cannot be empty!';
    }
  });

  if (isCancel(modsDir)) {
    outro(pc.yellow('Setup cancelled.'));
    process.exit(0);
  }

  const allowBeta = await confirm({
    message: 'Allow beta mod releases?',
    initialValue: false
  });

  if (isCancel(allowBeta)) {
    outro(pc.yellow('Setup cancelled.'));
    process.exit(0);
  }

  const maximumMemory = await text({
    message: 'Maximum memory for Minecraft:',
    placeholder: '4G',
    initialValue: '4G',
    validate(value) {
      const match = String(value || '').match(/^(\d+)([MG])$/i);
      if (!match) return 'Use a value such as 4G or 4096M.';
      const bytes = Number(match[1]) * (match[2].toUpperCase() === 'G' ? 1024 ** 3 : 1024 ** 2);
      if (bytes < 256 * 1024 ** 2) return 'Maximum memory must be at least 256M.';
    }
  });

  if (isCancel(maximumMemory)) {
    outro(pc.yellow('Setup cancelled.'));
    process.exit(0);
  }

  const profileName = await text({
    message: 'Launch profile name:',
    initialValue: path.basename(projectRoot),
    validate(value) {
      if (!value?.trim()) return 'The profile name cannot be empty!';
    }
  });

  if (isCancel(profileName)) {
    outro(pc.yellow('Setup cancelled.'));
    process.exit(0);
  }

  // Create initial config and lock files
  const config = {
    minecraftVersion: mcVersion,
    loader: loader,
    modsDir: modsDir,
    allowBeta: allowBeta,
    gameDir: '.',
    launcher: {
      memory: { min: '512M', max: maximumMemory.toUpperCase() },
      resolution: { width: 1280, height: 720 }
    },
    mods: {}
  };

  const lock = {
    minecraftVersion: mcVersion,
    loader: loader,
    allowBeta: allowBeta,
    installed: {}
  };

  const registered = await persistInitializedProject(
    projectRoot,
    config,
    lock,
    profileName.trim()
  );

  outro(pc.green(
    `MCPM project "${registered.name}" was initialized and set as active. ` +
    'Created mcpm.json and mcpm-lock.json.'
  ));
}
