import type { McpmError } from './errors.js';
import type { ModrinthVersion } from './types.js';
export function getAllowedVersionTypes(allowBeta?: boolean) {
  return allowBeta ? ['release', 'beta'] : ['release'];
}

function incompatibleVersion(message: string) {
  const error: McpmError = new Error(message);
  error.code = 'MCPM_VERSION_INCOMPATIBLE';
  return error;
}

export function assertVersionCompatible(version: ModrinthVersion, minecraftVersion: string, loader: string, allowBeta?: boolean) {
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

export function selectCompatibleVersion(versions: ModrinthVersion[], minecraftVersion: string, loader: string, allowBeta?: boolean) {
  const allowedTypes = getAllowedVersionTypes(allowBeta);
  const version = versions.find(candidate => allowedTypes.includes(candidate.version_type));

  if (!version) {
    throw new Error(`No ${allowedTypes.join(' or ')} version is available`);
  }

  return assertVersionCompatible(version, minecraftVersion, loader, allowBeta);
}
