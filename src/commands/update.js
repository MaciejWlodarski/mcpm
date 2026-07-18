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
    console.log(pc.cyan(`\n[${index + 1}/${directMods.length}] Updating ${pc.bold(slug)}...`));

    try {
      const result = await installer([slug], options);
      summary.downloaded += result.downloaded;
      summary.removed += result.removed;

      if (result.cleanupWarning) {
        console.warn(pc.yellow(
          `Warning for ${slug}: failed to remove the temporary directory: ` +
          result.cleanupWarning.message
        ));
      }

      if (result.downloaded === 0 && result.removed === 0) {
        summary.unchanged += 1;
        console.log(pc.gray(`${slug} is up to date.`));
      } else {
        summary.updated += 1;
        console.log(pc.green(`${slug} was updated.`));
      }
    } catch (error) {
      summary.failures.push({ slug, message: error.message });
      console.error(pc.yellow(`Skipped ${slug}: ${error.message}`));
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
    throw new Error('No MCPM project found. Use "mcpm use <project>" or "mcpm init"');
  }

  const config = await readConfig();
  const directMods = Object.keys(config.mods || {});

  if (directMods.length === 0) {
    console.log(pc.yellow('There are no installed mods to update.'));
    return null;
  }

  console.log(pc.cyan(
    `Checking updates for ${directMods.length} mods` +
    `${options.beta || config.allowBeta ? ' (beta allowed)' : ''}...`
  ));

  const summary = await updateProjects(directMods, options);
  console.log('\n' + pc.bold('Update summary:'));
  console.log(`  Updated:          ${pc.green(summary.updated)}`);
  console.log(`  Already current:  ${pc.cyan(summary.unchanged)}`);
  console.log(`  Skipped:          ${summary.failures.length ? pc.yellow(summary.failures.length) : '0'}`);

  if (summary.failures.length > 0) {
    console.log(pc.yellow('\nFailed to update:'));
    for (const failure of summary.failures) {
      console.log(`  - ${failure.slug}: ${failure.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(pc.bold(pc.green('\nUpdate completed successfully.')));
  }

  return summary;
}
