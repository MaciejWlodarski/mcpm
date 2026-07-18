import fs from 'fs/promises';
import path from 'path';
import ora from 'ora';
import pc from 'picocolors';

/**
 * Downloads a file from the given URL and saves it to target folder.
 * Shows a loading spinner in the terminal.
 * @param {string} url The download URL.
 * @param {string} destDir Destination folder.
 * @param {string} filename Output filename.
 */
export async function downloadFile(url, destDir, filename) {
  const destPath = path.join(destDir, filename);
  
  // Ensure the destination folder exists
  await fs.mkdir(destDir, { recursive: true });
  
  const spinner = ora(`Pobieranie ${pc.cyan(filename)}...`).start();
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'zireael/mcpm/1.0.0 (contact@zirea.el)'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Status HTTP ${response.status}: ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.writeFile(destPath, buffer);
    
    spinner.succeed(`Pobrano ${pc.green(filename)}`);
    return destPath;
  } catch (err) {
    spinner.fail(`Błąd pobierania ${pc.red(filename)}: ${err.message}`);
    throw err;
  }
}
