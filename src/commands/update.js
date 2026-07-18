import pc from 'picocolors';
import { isInitialized, readConfig } from '../config.js';
import { installProjects } from '../installer.js';

/**
 * Updates all directly installed mods in one transaction.
 * `upgrade` is a CLI alias for this same command.
 * @param {object} options Command line options.
 */
export async function updateCommand(options = {}) {
  if (!(await isInitialized())) {
    throw new Error('Projekt nie jest zainicjalizowany. Uruchom najpierw "mcpm init"');
  }

  const config = await readConfig();
  const directMods = Object.keys(config.mods || {});

  if (directMods.length === 0) {
    console.log(pc.yellow('Brak zainstalowanych modyfikacji do zaktualizowania.'));
    return null;
  }

  console.log(pc.cyan(
    `Sprawdzanie aktualizacji ${directMods.length} modyfikacji` +
    `${options.beta || config.allowBeta ? ' (beta dozwolone)' : ''}...`
  ));

  const result = await installProjects(directMods, options);
  if (result.cleanupWarning) {
    console.warn(pc.yellow(`Ostrzeżenie: nie udało się usunąć katalogu tymczasowego: ${result.cleanupWarning.message}`));
  }
  if (result.downloaded === 0 && result.removed === 0) {
    console.log(pc.green('Wszystkie modyfikacje są aktualne.'));
    return result;
  }

  console.log(pc.bold(pc.green(
    `Aktualizacja zakończona sukcesem (pobrano: ${result.downloaded}, usunięto: ${result.removed}).`
  )));
  return result;
}
