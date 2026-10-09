import { toError } from '../errors.js';
import { searchMods } from '../api.js';
import ora from 'ora';
import pc from 'picocolors';

/**
 * Searches for mods on Modrinth and prints the results to the console.
 * @param {string} query The search query string.
 */
export async function searchCommand(query: string) {
  if (!query || query.trim() === '') {
    console.error(pc.red('Error: provide a search query. Example: mcpm search sodium'));
    process.exit(1);
  }

  const spinner = ora(`Searching Modrinth for "${pc.cyan(query)}"...`).start();

  try {
    const results = await searchMods(query);
    
    if (results.length === 0) {
      spinner.info(`No mods found for: "${query}"`);
      return;
    }

    spinner.stop();
    console.log(`\nMods found for "${pc.cyan(query)}":\n`);

    results.forEach(mod => {
      const title = pc.bold(pc.cyan(mod.title));
      const slug = pc.yellow(`[slug: ${mod.slug}]`);
      const downloads = pc.green(`${mod.downloads.toLocaleString()} downloads`);
      const author = pc.gray(`Author: ${mod.author}`);
      
      console.log(`${title} ${slug} - ${downloads} (${author})`);
      if (mod.description) {
        const desc = mod.description.trim();
        const truncatedDesc = desc.length > 90 ? desc.slice(0, 87) + '...' : desc;
        console.log(`  ${pc.gray(truncatedDesc)}`);
      }
      console.log(); // Blank line for spacing
    });
  } catch (errCause) {
    const err = toError(errCause);
    spinner.fail(`Search failed: ${err.message}`);
    process.exit(1);
  }
}
