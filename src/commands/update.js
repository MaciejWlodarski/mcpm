import pc from 'picocolors';
import { isInitialized, readConfig } from '../config.js';
import { installProjects } from '../installer.js';

export async function updateProjects(directMods, options = {}, installer = installProjects) {
  const summary = {
    checked: directMods.length,
    updated: 0,
    unchanged: 0,
    downloaded: 0,
    removed: 0,
    failures: []
  };

  for (const [index, slug] of directMods.entries()) {
    console.log(pc.cyan(`\n[${index + 1}/${directMods.length}] Aktualizacja ${pc.bold(slug)}...`));

    try {
      const result = await installer([slug], options);
      summary.downloaded += result.downloaded;
      summary.removed += result.removed;

      if (result.cleanupWarning) {
        console.warn(pc.yellow(
          `Ostrzeżenie dla ${slug}: nie udało się usunąć katalogu tymczasowego: ` +
          result.cleanupWarning.message
        ));
      }

      if (result.downloaded === 0 && result.removed === 0) {
        summary.unchanged += 1;
        console.log(pc.gray(`${slug} jest aktualny.`));
      } else {
        summary.updated += 1;
        console.log(pc.green(`${slug} zaktualizowany.`));
      }
    } catch (error) {
      summary.failures.push({ slug, message: error.message });
      console.error(pc.yellow(`Pominięto ${slug}: ${error.message}`));
    }
  }

  return summary;
}

/**
 * Updates direct mods independently, keeping successful updates when another mod fails.
 * @param {object} options Command line options.
 */
export async function updateCommand(options = {}) {
  if (!(await isInitialized())) {
    throw new Error('Nie znaleziono projektu MCPM. Użyj "mcpm use <projekt>" albo "mcpm init"');
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

  const summary = await updateProjects(directMods, options);
  console.log('\n' + pc.bold('Podsumowanie aktualizacji:'));
  console.log(`  Zaktualizowane: ${pc.green(summary.updated)}`);
  console.log(`  Już aktualne:   ${pc.cyan(summary.unchanged)}`);
  console.log(`  Pominięte:      ${summary.failures.length ? pc.yellow(summary.failures.length) : '0'}`);

  if (summary.failures.length > 0) {
    console.log(pc.yellow('\nNie udało się zaktualizować:'));
    for (const failure of summary.failures) {
      console.log(`  - ${failure.slug}: ${failure.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(pc.bold(pc.green('\nAktualizacja zakończona sukcesem.')));
  }

  return summary;
}
