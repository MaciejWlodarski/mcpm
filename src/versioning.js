export function getAllowedVersionTypes(allowBeta) {
  return allowBeta ? ['release', 'beta'] : ['release'];
}

export function assertVersionCompatible(version, minecraftVersion, loader, allowBeta) {
  const allowedTypes = getAllowedVersionTypes(allowBeta);

  if (!allowedTypes.includes(version.version_type)) {
    throw new Error(
      `Version ${version.version_number} has unsupported type "${version.version_type}" ` +
      `(allowed: ${allowedTypes.join(', ')})`
    );
  }

  if (Array.isArray(version.game_versions) && !version.game_versions.includes(minecraftVersion)) {
    throw new Error(`Version ${version.version_number} does not support Minecraft ${minecraftVersion}`);
  }

  if (Array.isArray(version.loaders) && !version.loaders.includes(loader)) {
    throw new Error(`Version ${version.version_number} does not support the ${loader} loader`);
  }

  return version;
}

export function selectCompatibleVersion(versions, minecraftVersion, loader, allowBeta) {
  const allowedTypes = getAllowedVersionTypes(allowBeta);
  const version = versions.find(candidate => allowedTypes.includes(candidate.version_type));

  if (!version) {
    throw new Error(`No ${allowedTypes.join(' or ')} version is available`);
  }

  return assertVersionCompatible(version, minecraftVersion, loader, allowBeta);
}
