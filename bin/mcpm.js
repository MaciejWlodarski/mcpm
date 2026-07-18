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
  .description('Zainicjalizuj projekt mcpm w obecnym katalogu')
  .action(initCommand);

program
  .command('search <query>')
  .description('Wyszukaj modyfikacje na platformie Modrinth')
  .action(searchCommand);

program
  .command('use <project>')
  .description('Ustaw aktywny projekt MCPM według nazwy lub ścieżki')
  .action(useCommand);

program
  .command('projects')
  .description('Wyświetl zarejestrowane projekty MCPM')
  .action(projectsCommand);

program
  .command('current')
  .description('Wyświetl projekt używany przez polecenia MCPM w tym katalogu')
  .action(currentCommand);

program
  .command('forget <project>')
  .description('Usuń projekt z rejestru bez usuwania jego plików')
  .action(forgetCommand);

program
  .command('config')
  .description('Wyświetl lub zmień ustawienia bieżącego projektu')
  .option('--beta <on|off>', 'Trwale włącz lub wyłącz wersje beta dla projektu')
  .action(configCommand);

const featureCommand = program
  .command('feature')
  .description('Zarządzaj opcjonalnymi feature’ami MCPM');

featureCommand
  .command('list')
  .description('Wyświetl dostępne i zainstalowane feature’y')
  .action(featureListCommand);

featureCommand
  .command('install <name>')
  .description('Zainstaluj opcjonalny feature MCPM')
  .option('--source <path>', 'Użyj lokalnego źródła pakietu podczas developmentu')
  .action(featureInstallCommand);

featureCommand
  .command('uninstall <name>')
  .description('Odinstaluj opcjonalny feature MCPM')
  .action(featureUninstallCommand);

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
  .option('-b, --beta', 'Dopuść wersje próbne (beta) podczas aktualizacji')
  .description('Zaktualizuj wszystkie mody dla bieżącej wersji Minecraft')
  .action((options) => updateCommand(options));

program
  .command('list')
  .alias('ls')
  .description('Wyświetl listę wszystkich zainstalowanych modyfikacji')
  .action(listCommand);

program
  .command('upgrade <version>')
  .option('-b, --beta', 'Dopuść wersje próbne (beta) dla nowej wersji gry')
  .description('Zmień wersję Minecraft projektu i przeinstaluj modyfikacje')
  .action((version, options) => upgradeCommand(version, options));

const featureLoadResult = await loadInstalledFeatures(program);
for (const failure of featureLoadResult.failures) {
  console.warn(pc.yellow(`Nie udało się załadować feature’a ${failure.name}: ${failure.message}`));
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(pc.red(`\nBłąd: ${error.message}`));
  process.exitCode = 1;
}
