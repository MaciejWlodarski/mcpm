import pc from 'picocolors';
import { isInitialized } from '../config.js';
import { installProjects } from '../installer.js';

/**
 * Installs a mod and all of its required dependencies.
 * @param {string} slugOrId The slug or ID of the mod to install.
 * @param {object} options Command line options.
 */
export async function installCommand(slugOrId, options = {}) {
  if (!slugOrId || slugOrId.trim() === '') {
    throw new Error('Podaj slug lub ID moda do zainstalowania. Przykład: mcpm install sodium');
  }

  if (!(await isInitialized())) {
    throw new Error('Nie znaleziono projektu MCPM. Użyj "mcpm use <projekt>" albo "mcpm init"');
  }

  console.log(pc.cyan(`Rozwiązywanie zależności dla: ${pc.bold(slugOrId)}...`));
  const result = await installProjects([slugOrId], options);
  if (result.cleanupWarning) {
    console.warn(pc.yellow(`Ostrzeżenie: nie udało się usunąć katalogu tymczasowego: ${result.cleanupWarning.message}`));
  }

  if (result.downloaded === 0 && result.removed === 0) {
    console.log(pc.green('Modyfikacja i jej zależności są już aktualne.'));
    return result;
  }

  console.log(pc.bold(pc.green(
    `Instalacja zakończona sukcesem (pobrano: ${result.downloaded}, usunięto: ${result.removed}).`
  )));
  return result;
}
