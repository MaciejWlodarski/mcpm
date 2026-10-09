#!/usr/bin/env node
import { toError } from '../src/errors.js';

import { Command } from 'commander';
import { initCommand } from '../src/commands/init.js';
import { searchCommand } from '../src/commands/search.js';
import { installCommand } from '../src/commands/install.js';
import { removeCommand } from '../src/commands/remove.js';
import { updateCommand } from '../src/commands/update.js';
import { listCommand } from '../src/commands/list.js';
import { addFileCommand, openModsCommand } from '../src/commands/manual-mods.js';
import { upgradeCommand, type UpgradeOptions } from '../src/commands/upgrade.js';
import type { InstallOptions } from '../src/types.js';
import { currentCommand, forgetCommand, projectsCommand, useCommand } from '../src/commands/projects.js';
import { configCommand } from '../src/commands/configure.js';
import {
  featureInstallCommand,
  featureListCommand,
  featureUninstallCommand
} from '../src/commands/features.js';
import { loadInstalledFeatures } from '../src/features.js';
import pc from 'picocolors';

// Commander ignores command return values; callers and tests can still use them.
function action<Args extends unknown[]>(handler: (...args: Args) => unknown | Promise<unknown>) {
  return async (...args: Args): Promise<void> => { await handler(...args); };
}

const program = new Command();

program
  .name('mcpm')
  .description('Minecraft Package Manager - CLI mod manager powered by Modrinth API')
  .version('1.1.0');

program
  .command('init [path]')
  .description('Initialize an MCPM profile in the selected or current directory')
  .action(action(initCommand));

program
  .command('search <query>')
  .description('Search for mods on Modrinth')
  .action(action(searchCommand));

program
  .command('use <project>')
  .description('Set the active MCPM project by name or path')
  .action(action(useCommand));

program
  .command('projects')
  .description('Show registered MCPM projects')
  .action(action(projectsCommand));

program
  .command('current')
  .description('Show the MCPM project used in the current directory')
  .action(action(currentCommand));

program
  .command('forget <project>')
  .description('Remove a project from the registry without deleting its files')
  .action(action(forgetCommand));

program
  .command('config')
  .description('Show or change the current project settings')
  .option('--beta <on|off>', 'Persistently enable or disable beta releases for the project')
  .option('--java <path|auto>', 'Set a Java executable/home path, or use auto detection')
  .option('--memory <size>', 'Set maximum game memory, for example 4G or 4096M')
  .option('--resolution <widthxheight>', 'Set the default game window resolution')
  .option('--game-dir <path>', 'Set the profile game directory relative to the project')
  .action(action(configCommand));

const featureCommand = program
  .command('feature')
  .description('Manage optional MCPM features');

featureCommand
  .command('list')
  .description('Show available and installed features')
  .action(action(featureListCommand));

featureCommand
  .command('install <name>')
  .description('Install an optional MCPM feature')
  .option('--source <path>', 'Use a local package source during development')
  .action(action(featureInstallCommand));

featureCommand
  .command('uninstall <name>')
  .description('Uninstall an optional MCPM feature')
  .action(action(featureUninstallCommand));

program
  .command('install <slug>')
  .alias('add')
  .option('-b, --beta', 'Allow beta releases')
  .description('Install a mod and its required dependencies')
  .action(action(installCommand));

program
  .command('add-file <path>')
  .description('Copy a local JAR into the current profile as a manual mod')
  .action(action((source: string) => addFileCommand(source)));

program
  .command('open-mods [profile]')
  .description('Open the mods folder for the current or selected profile')
  .action(action((profile?: string) => openModsCommand(profile)));

program
  .command('remove <slug>')
  .alias('uninstall')
  .description('Remove a mod and its orphaned dependencies')
  .action(action(removeCommand));

program
  .command('update')
  .option('-b, --beta', 'Allow beta releases during updates')
  .description('Update all mods for the current Minecraft version')
  .action(action((options: InstallOptions) => updateCommand(options)));

program
  .command('list')
  .alias('ls')
  .description('List all installed mods')
  .action(action(listCommand));

program
  .command('upgrade <version>')
  .option('-b, --beta', 'Allow beta releases for the new game version')
  .option('--loader <loader>', 'Change the mod loader while upgrading')
  .option('--check', 'Check managed mod versions and dependencies without changing the profile')
  .description('Upgrade the Minecraft version, loader, and managed mods')
  .action(async (version: string, options: UpgradeOptions) => {
    const result = await upgradeCommand(version, options);
    if (options.check && result && 'compatible' in result && result.compatible === false) process.exitCode = 1;
  });

const featureLoadResult = await loadInstalledFeatures(program);
for (const failure of featureLoadResult.failures) {
  console.warn(pc.yellow(`Failed to load feature ${failure.name}: ${failure.message}`));
}

try {
  await program.parseAsync(process.argv);
} catch (errorCause) {
  const error = toError(errorCause);
  console.error(pc.red(`\nError: ${error.message}`));
  process.exitCode = 1;
}
