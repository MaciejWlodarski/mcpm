import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';

function filenameKey(filename) {
  return ['darwin', 'win32'].includes(process.platform) ? filename.toLowerCase() : filename;
}

function managedFilenames(lock) {
  return new Set(Object.values(lock.installed || {})
    .map(mod => mod.filename)
    .filter(Boolean)
    .map(filenameKey));
}

export async function findManualMods(modsDirectory, lock) {
  let entries;
  try {
    entries = await fs.readdir(modsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const managed = managedFilenames(lock);
  const manual = [];
  for (const entry of entries) {
    if (!/\.jar$/i.test(entry.name) || managed.has(filenameKey(entry.name))) continue;
    const filePath = path.join(modsDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        if (!(await fs.stat(filePath)).isFile()) continue;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    } else if (!entry.isFile()) {
      continue;
    }
    manual.push({ filename: entry.name, path: filePath });
  }
  return manual.sort((left, right) => left.filename.localeCompare(right.filename));
}

export async function copyManualMod(source, modsDirectory, lock) {
  const sourcePath = path.resolve(source);
  const filename = path.basename(sourcePath);
  if (!/\.jar$/i.test(filename)) throw new Error('Manual mods must be .jar files.');
  if (!(await fs.stat(sourcePath)).isFile()) throw new Error('The manual mod must be a file.');
  if (managedFilenames(lock).has(filenameKey(filename))) {
    throw new Error(`File ${filename} is already managed by MCPM. Choose a different filename.`);
  }
  await fs.mkdir(modsDirectory, { recursive: true });
  const destination = path.join(modsDirectory, filename);
  try {
    await fs.copyFile(sourcePath, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`File ${filename} already exists in the mods folder; it was not replaced.`, { cause: error });
    }
    throw error;
  }
  return { filename, path: destination };
}
