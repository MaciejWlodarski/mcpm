#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from '../src/commands/init.js';
import { searchCommand } from '../src/commands/search.js';
import { installCommand } from '../src/commands/install.js';
import { removeCommand } from '../src/commands/remove.js';
import { updateCommand } from '../src/commands/update.js';
import { listCommand } from '../src/commands/list.js';
import { upgradeMcCommand } from '../src/commands/upgradeMc.js';
import pc from 'picocolors';

const program = new Command();

program
  .name('mcpm')
  .description('Minecraft Package Manager - CLI mod manager powered by Modrinth API')
  .version('1.0.0');

program
  .command('init')
  .description('Zainicjalizuj projekt mcpm w obecnym katalogu')
  .action(initCommand);

program
  .command('search <query>')
  .description('Wyszukaj modyfikacje na platformie Modrinth')
  .action(searchCommand);

program
  .command('install <slug>')
  .alias('add')
  .option('-b, --beta', 'Dopuść wersje próbne (beta)')
  .description('Zainstaluj modyfikację oraz jej wymagane zależności')
  .action(installCommand);

program
  .command('remove <slug>')
  .alias('uninstall')
  .description('Usuń modyfikację oraz jej osierocone zależności')
  .action(removeCommand);

program
  .command('update')
  .alias('upgrade')
  .option('-b, --beta', 'Dopuść wersje próbne (beta) podczas aktualizacji')
  .description('Zaktualizuj wszystkie mody (upgrade jest aliasem tego polecenia)')
  .action((options) => updateCommand(options));

program
  .command('list')
  .alias('ls')
  .description('Wyświetl listę wszystkich zainstalowanych modyfikacji')
  .action(listCommand);

program
  .command('upgrade-mc <version>')
  .option('-b, --beta', 'Dopuść wersje próbne (beta) dla nowej wersji gry')
  .description('Zmień wersję Minecraft projektu i przeinstaluj modyfikacje')
  .action((version, options) => upgradeMcCommand(version, options));

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(pc.red(`\nBłąd: ${error.message}`));
  process.exitCode = 1;
}
