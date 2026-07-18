export function getAllowedVersionTypes(allowBeta) {
  return allowBeta ? ['release', 'beta'] : ['release'];
}

export function assertVersionCompatible(version, minecraftVersion, loader, allowBeta) {
  const allowedTypes = getAllowedVersionTypes(allowBeta);

  if (!allowedTypes.includes(version.version_type)) {
    throw new Error(
      `Wersja ${version.version_number} ma niedozwolony typ "${version.version_type}" ` +
      `(dozwolone: ${allowedTypes.join(', ')})`
    );
  }

  if (Array.isArray(version.game_versions) && !version.game_versions.includes(minecraftVersion)) {
    throw new Error(`Wersja ${version.version_number} nie obsługuje Minecraft ${minecraftVersion}`);
  }

  if (Array.isArray(version.loaders) && !version.loaders.includes(loader)) {
    throw new Error(`Wersja ${version.version_number} nie obsługuje loadera ${loader}`);
  }

  return version;
}

export function selectCompatibleVersion(versions, minecraftVersion, loader, allowBeta) {
  const allowedTypes = getAllowedVersionTypes(allowBeta);
  const version = versions.find(candidate => allowedTypes.includes(candidate.version_type));

  if (!version) {
    throw new Error(`Brak wersji typu ${allowedTypes.join(' lub ')}`);
  }

  return assertVersionCompatible(version, minecraftVersion, loader, allowBeta);
}

