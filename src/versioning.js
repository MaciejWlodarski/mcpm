export function getAllowedVersionTypes(allowBeta) {
  return allowBeta ? ['release', 'beta'] : ['release'];
}

function incompatibleVersion(message) {
  const error = new Error(message);
  error.code = 'MCPM_VERSION_INCOMPATIBLE';
  return error;
}

export function assertVersionCompatible(version, minecraftVersion, loader, allowBeta) {
  const allowedTypes = getAllowedVersionTypes(allowBeta);

  if (!allowedTypes.includes(version.version_type)) {
    throw incompatibleVersion(
      `Version ${version.version_number} has unsupported type "${version.version_type}" ` +
      `(allowed: ${allowedTypes.join(', ')})`
    );
  }

  if (Array.isArray(version.game_versions) && !version.game_versions.includes(minecraftVersion)) {
    throw incompatibleVersion(`Version ${version.version_number} does not support Minecraft ${minecraftVersion}`);
  }

  if (Array.isArray(version.loaders) && !version.loaders.includes(loader)) {
    throw incompatibleVersion(`Version ${version.version_number} does not support the ${loader} loader`);
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
