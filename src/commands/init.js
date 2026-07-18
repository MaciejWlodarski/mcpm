import { intro, outro, select, text, confirm, isCancel, spinner } from '@clack/prompts';
import pc from 'picocolors';
import { getGameVersions } from '../api.js';
import { writeConfig, writeLock } from '../config.js';
import { registerProject } from '../projects.js';

/**
 * Executes the `mcpm init` command to interactively create configuration files.
 */
export async function initCommand() {
  intro(pc.bgCyan(pc.black(' MCPM - Project setup ')));

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

  // Create initial config and lock files
  const config = {
    minecraftVersion: mcVersion,
    loader: loader,
    modsDir: modsDir,
    allowBeta: allowBeta,
    mods: {}
  };

  const lock = {
    minecraftVersion: mcVersion,
    loader: loader,
    allowBeta: allowBeta,
    installed: {}
  };

  const projectRoot = process.cwd();
  await writeConfig(config, projectRoot);
  await writeLock(lock, projectRoot);
  const registered = await registerProject(projectRoot);

  outro(pc.green(
    `MCPM project "${registered.name}" was initialized and set as active. ` +
    'Created mcpm.json and mcpm-lock.json.'
  ));
}
