#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from '../src/commands/init.js';
import { searchCommand } from '../src/commands/search.js';
import { installCommand } from '../src/commands/install.js';
import { removeCommand } from '../src/commands/remove.js';
import { updateCommand } from '../src/commands/update.js';
import { listCommand } from '../src/commands/list.js';
import { upgradeCommand } from '../src/commands/upgrade.js';
import { currentCommand, forgetCommand, projectsCommand, useCommand } from '../src/commands/projects.js';
import { configCommand } from '../src/commands/configure.js';
import {
  featureInstallCommand,
  featureListCommand,
  featureUninstallCommand
} from '../src/commands/features.js';
import { loadInstalledFeatures } from '../src/features.js';
import pc from 'picocolors';

const program = new Command();

program
  .name('mcpm')
  .description('Minecraft Package Manager - CLI mod manager powered by Modrinth API')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize an MCPM project in the current directory')
  .action(initCommand);

program
  .command('search <query>')
  .description('Search for mods on Modrinth')
  .action(searchCommand);

program
  .command('use <project>')
  .description('Set the active MCPM project by name or path')
  .action(useCommand);

program
  .command('projects')
  .description('Show registered MCPM projects')
  .action(projectsCommand);

program
  .command('current')
  .description('Show the MCPM project used in the current directory')
  .action(currentCommand);

program
  .command('forget <project>')
  .description('Remove a project from the registry without deleting its files')
  .action(forgetCommand);

program
  .command('config')
  .description('Show or change the current project settings')
  .option('--beta <on|off>', 'Persistently enable or disable beta releases for the project')
  .action(configCommand);

const featureCommand = program
  .command('feature')
  .description('Manage optional MCPM features');

featureCommand
  .command('list')
  .description('Show available and installed features')
  .action(featureListCommand);

featureCommand
  .command('install <name>')
  .description('Install an optional MCPM feature')
  .option('--source <path>', 'Use a local package source during development')
  .action(featureInstallCommand);

featureCommand
  .command('uninstall <name>')
  .description('Uninstall an optional MCPM feature')
  .action(featureUninstallCommand);

program
  .command('install <slug>')
  .alias('add')
  .option('-b, --beta', 'Allow beta releases')
  .description('Install a mod and its required dependencies')
  .action(installCommand);

program
  .command('remove <slug>')
  .alias('uninstall')
  .description('Remove a mod and its orphaned dependencies')
  .action(removeCommand);

program
  .command('update')
  .option('-b, --beta', 'Allow beta releases during updates')
  .description('Update all mods for the current Minecraft version')
  .action((options) => updateCommand(options));

program
  .command('list')
  .alias('ls')
  .description('List all installed mods')
  .action(listCommand);

program
  .command('upgrade <version>')
  .option('-b, --beta', 'Allow beta releases for the new game version')
  .description('Change the project Minecraft version and reinstall its mods')
  .action((version, options) => upgradeCommand(version, options));

const featureLoadResult = await loadInstalledFeatures(program);
for (const failure of featureLoadResult.failures) {
  console.warn(pc.yellow(`Failed to load feature ${failure.name}: ${failure.message}`));
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(pc.red(`\nError: ${error.message}`));
  process.exitCode = 1;
}
