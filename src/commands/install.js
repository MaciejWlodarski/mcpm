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
    throw new Error('Provide the slug or ID of the mod to install. Example: mcpm install sodium');
  }

  if (!(await isInitialized())) {
    throw new Error('No MCPM project found. Use "mcpm use <project>" or "mcpm init"');
  }

  console.log(pc.cyan(`Resolving dependencies for ${pc.bold(slugOrId)}...`));
  const result = await installProjects([slugOrId], options);
  if (result.cleanupWarning) {
    console.warn(pc.yellow(`Warning: failed to remove the temporary directory: ${result.cleanupWarning.message}`));
  }

  if (result.downloaded === 0 && result.removed === 0) {
    console.log(pc.green('The mod and its dependencies are already up to date.'));
    return result;
  }

  console.log(pc.bold(pc.green(
    `Installation completed successfully (downloaded: ${result.downloaded}, removed: ${result.removed}).`
  )));
  return result;
}
