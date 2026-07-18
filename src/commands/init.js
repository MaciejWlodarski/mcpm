import { intro, outro, select, text, confirm, isCancel, spinner } from '@clack/prompts';
import pc from 'picocolors';
import { getGameVersions } from '../api.js';
import { writeConfig, writeLock } from '../config.js';

/**
 * Executes the `mcpm init` command to interactively create configuration files.
 */
export async function initCommand() {
  intro(pc.bgCyan(pc.black(' MCPM - Inicjalizacja projektu ')));

  let mcVersions = [];
  const s = spinner();
  s.start('Pobieranie wersji Minecraft z Modrinth...');
  try {
    const rawVersions = await getGameVersions();
    // Filter to releases, sort by date descending
    mcVersions = rawVersions
      .filter(v => v.version_type === 'release')
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(v => v.version);
    s.stop('Wersje Minecraft pobrane.');
  } catch (err) {
    s.stop('Nie udało się pobrać wersji z Modrinth (użycie trybu offline).');
  }

  // Build options for selecting Minecraft version
  let mcVersionOptions = [];
  if (mcVersions.length > 0) {
    // Take the top 12 versions
    mcVersionOptions = mcVersions.slice(0, 12).map(v => ({ value: v, label: v }));
    mcVersionOptions.push({ value: 'custom', label: 'Wpisz inną wersję...' });
  }

  let mcVersion;
  if (mcVersionOptions.length > 0) {
    mcVersion = await select({
      message: 'Wybierz wersję Minecraft:',
      options: mcVersionOptions
    });
    
    if (isCancel(mcVersion)) {
      outro(pc.yellow('Inicjalizacja anulowana.'));
      process.exit(0);
    }
    
    if (mcVersion === 'custom') {
      mcVersion = await text({
        message: 'Podaj wersję Minecraft:',
        placeholder: '1.20.1',
        validate(value) {
          if (!value) return 'Wersja nie może być pusta!';
        }
      });
      if (isCancel(mcVersion)) {
        outro(pc.yellow('Inicjalizacja anulowana.'));
        process.exit(0);
      }
    }
  } else {
    // Fallback if API failed or empty
    mcVersion = await text({
      message: 'Podaj wersję Minecraft (np. 1.20.1):',
      placeholder: '1.20.1',
      validate(value) {
        if (!value) return 'Wersja nie może być pusta!';
      }
    });
    if (isCancel(mcVersion)) {
      outro(pc.yellow('Inicjalizacja anulowana.'));
      process.exit(0);
    }
  }

  const loader = await select({
    message: 'Wybierz mod loader:',
    options: [
      { value: 'fabric', label: 'Fabric' },
      { value: 'forge', label: 'Forge' },
      { value: 'neoforge', label: 'NeoForge' },
      { value: 'quilt', label: 'Quilt' }
    ]
  });

  if (isCancel(loader)) {
    outro(pc.yellow('Inicjalizacja anulowana.'));
    process.exit(0);
  }

  const modsDir = await text({
    message: 'Ścieżka do folderu z modami:',
    placeholder: './mods',
    initialValue: './mods',
    validate(value) {
      if (!value) return 'Ścieżka nie może być pusta!';
    }
  });

  if (isCancel(modsDir)) {
    outro(pc.yellow('Inicjalizacja anulowana.'));
    process.exit(0);
  }

  const allowBeta = await confirm({
    message: 'Czy dopuszczać wersje próbne (beta) modyfikacji?',
    initialValue: false
  });

  if (isCancel(allowBeta)) {
    outro(pc.yellow('Inicjalizacja anulowana.'));
    process.exit(0);
  }

  // Create initial config and lock files
  const config = {
    minecraftVersion: mcVersion,
    loader: loader,
    modsDir: modsDir,
    allowBeta: allowBeta,
    mods: {}
  };

  const lock = {
    minecraftVersion: mcVersion,
    loader: loader,
    allowBeta: allowBeta,
    installed: {}
  };

  await writeConfig(config);
  await writeLock(lock);

  outro(pc.green('Projekt MCPM pomyślnie zainicjalizowany! Stworzono mcpm.json oraz mcpm-lock.json.'));
}
