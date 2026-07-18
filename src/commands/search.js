import { searchMods } from '../api.js';
import ora from 'ora';
import pc from 'picocolors';

/**
 * Searches for mods on Modrinth and prints the results to the console.
 * @param {string} query The search query string.
 */
export async function searchCommand(query) {
  if (!query || query.trim() === '') {
    console.error(pc.red('Błąd: Podaj frazę do wyszukania. Przykład: mcpm search sodium'));
    process.exit(1);
  }

  const spinner = ora(`Wyszukiwanie "${pc.cyan(query)}" w Modrinth...`).start();

  try {
    const results = await searchMods(query);
    
    if (results.length === 0) {
      spinner.info(`Nie znaleziono modów dla frazy: "${query}"`);
      return;
    }

    spinner.stop();
    console.log(`\nZnalezione mody dla "${pc.cyan(query)}":\n`);

    results.forEach(mod => {
      const title = pc.bold(pc.cyan(mod.title));
      const slug = pc.yellow(`[slug: ${mod.slug}]`);
      const downloads = pc.green(`${mod.downloads.toLocaleString()} pobrań`);
      const author = pc.gray(`Autor: ${mod.author}`);
      
      console.log(`${title} ${slug} - ${downloads} (${author})`);
      if (mod.description) {
        const desc = mod.description.trim();
        const truncatedDesc = desc.length > 90 ? desc.slice(0, 87) + '...' : desc;
        console.log(`  ${pc.gray(truncatedDesc)}`);
      }
      console.log(); // Blank line for spacing
    });
  } catch (err) {
    spinner.fail(`Błąd podczas wyszukiwania: ${err.message}`);
    process.exit(1);
  }
}
