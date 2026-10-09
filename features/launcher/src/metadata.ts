import type { ArgumentEntry, LaunchMetadata, Library, LibraryArtifact, ProfileConfig, Rule, RuleOptions, RuntimeOptions, VersionEntry, VersionMetadata } from './types.js';
import os from 'os';
import path from 'path';
import { requestJson } from './downloads.js';

export const VERSION_MANIFEST_URL =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const FABRIC_META_URL = 'https://meta.fabricmc.net/v2';
export const DEFAULT_MAVEN_URL = 'https://libraries.minecraft.net/';

export function getMinecraftOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

export function getMinecraftArch() {
  return process.arch === 'ia32' ? 'x86' : process.arch;
}

function compareVersionParts(left: string, right: string) {
  const leftParts = String(left).split(/[^0-9]+/).filter(Boolean).map(Number);
  const rightParts = String(right).split(/[^0-9]+/).filter(Boolean).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function matchesOs(ruleOs: Rule['os'], environment: { osName: string; arch: string; osVersion: string }) {
  if (!ruleOs) return true;
  if (ruleOs.name && ruleOs.name !== environment.osName) return false;
  if (ruleOs.arch && ruleOs.arch !== environment.arch) return false;
  if (ruleOs.version) {
    try {
      if (!new RegExp(ruleOs.version).test(environment.osVersion)) return false;
    } catch {
      return false;
    }
  }
  if (ruleOs.versionRange?.min &&
      compareVersionParts(environment.osVersion, ruleOs.versionRange.min) < 0) return false;
  if (ruleOs.versionRange?.max &&
      compareVersionParts(environment.osVersion, ruleOs.versionRange.max) >= 0) return false;
  return true;
}

function matchesFeatures(ruleFeatures: Rule['features'], features: Record<string, boolean>) {
  if (!ruleFeatures) return true;
  return Object.entries(ruleFeatures).every(([name, expected]) => Boolean(features[name]) === expected);
}

export function rulesAllow(rules: Rule[] | undefined, options: RuleOptions = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const environment = {
    osName: options.osName || getMinecraftOs(),
    arch: options.arch || getMinecraftArch(),
    osVersion: options.osVersion || os.release(),
    features: options.features || {}
  };
  let allowed = false;
  for (const rule of rules) {
    if (matchesOs(rule.os, environment) && matchesFeatures(rule.features, environment.features)) {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

export function evaluateArguments(entries: ArgumentEntry[] = [], options: RuleOptions = {}) {
  const values = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      values.push(entry);
      continue;
    }
    if (!entry || !rulesAllow(entry.rules, options)) continue;
    if (Array.isArray(entry.value)) values.push(...entry.value);
    else if (typeof entry.value === 'string') values.push(entry.value);
  }
  return values;
}

export function mavenArtifactPath(name: string) {
  const [coordinate, extension = 'jar'] = name.split('@');
  const parts = coordinate.split(':');
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(`Unsupported Maven coordinate: ${name}`);
  }
  const [group, artifact, version, classifier] = parts;
  const filename = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  return path.posix.join(group.replaceAll('.', '/'), artifact, version, filename);
}

function joinUrl(baseUrl: string, relativePath: string) {
  return `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}${relativePath}`;
}

export function getLibraryArtifact(library: Library): LibraryArtifact {
  if (library.downloads?.artifact) {
    const artifact = library.downloads.artifact;
    return { ...artifact, path: artifact.path || mavenArtifactPath(library.name) };
  }
  const artifactPath = mavenArtifactPath(library.name);
  return {
    path: artifactPath,
    url: joinUrl(library.url || DEFAULT_MAVEN_URL, artifactPath),
    sha1: library.sha1,
    size: library.size
  };
}

export function getLibraryNative(library: Library, options: RuleOptions = {}) {
  const osName = options.osName || getMinecraftOs();
  const classifierTemplate = library.natives?.[osName];
  if (!classifierTemplate) return null;
  const bits = process.arch === 'ia32' ? '32' : '64';
  const classifier = classifierTemplate.replace('${arch}', bits);
  const native = library.downloads?.classifiers?.[classifier];
  if (!native) return null;
  return { ...native, classifier, exclude: library.extract?.exclude || [] };
}

export async function getVanillaVersion(versionId: string, options: RuntimeOptions = {}) {
  const manifest = await requestJson<{ versions: VersionEntry[] }>(VERSION_MANIFEST_URL, options);
  const entry = manifest.versions?.find(version => version.id === versionId);
  if (!entry) throw new Error(`Minecraft version ${versionId} was not found in Mojang metadata.`);
  const version = await requestJson<VersionMetadata>(entry.url, options);
  return { entry, version };
}

export async function getFabricProfile(gameVersion: string, requestedLoaderVersion?: string, options: RuntimeOptions = {}) {
  const loaders = await requestJson<{ loader: { version: string; stable: boolean } }[]>(
    `${FABRIC_META_URL}/versions/loader/${encodeURIComponent(gameVersion)}`,
    options
  );
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`Fabric Loader is not available for Minecraft ${gameVersion}.`);
  }

  const selected = requestedLoaderVersion
    ? loaders.find(item => item.loader?.version === requestedLoaderVersion)
    : loaders.find(item => item.loader?.stable) || loaders[0];
  if (!selected) {
    throw new Error(
      `Fabric Loader ${requestedLoaderVersion} is not available for Minecraft ${gameVersion}.`
    );
  }
  const loaderVersion = selected.loader.version;
  const profile = await requestJson<VersionMetadata>(
    `${FABRIC_META_URL}/versions/loader/${encodeURIComponent(gameVersion)}/` +
      `${encodeURIComponent(loaderVersion)}/profile/json`,
    options
  );
  return { loaderVersion, profile };
}

function mergeLibraries(baseLibraries: Library[] = [], extraLibraries: Library[] = []) {
  const libraries = new Map();
  for (const library of [...baseLibraries, ...extraLibraries]) {
    const key = library.name;
    if (libraries.has(key)) libraries.delete(key);
    libraries.set(key, library);
  }
  return [...libraries.values()];
}

export async function resolveLaunchMetadata(config: ProfileConfig, options: RuntimeOptions = {}): Promise<LaunchMetadata> {
  if (!['vanilla', 'fabric'].includes(config.loader)) {
    throw new Error(
      `Direct launching currently supports vanilla and Fabric profiles; received loader ${config.loader}.`
    );
  }
  const { entry, version: vanilla } = await getVanillaVersion(config.minecraftVersion, options);
  if (!config.loader || config.loader === 'vanilla') {
    return {
      id: vanilla.id,
      loader: 'vanilla',
      loaderVersion: null,
      entry,
      vanilla,
      profile: vanilla,
      mainClass: vanilla.mainClass,
      libraries: vanilla.libraries || [],
      arguments: vanilla.arguments || null,
      minecraftArguments: vanilla.minecraftArguments || null
    };
  }

  const { loaderVersion, profile } = await getFabricProfile(
    config.minecraftVersion,
    config.loaderVersion,
    options
  );
  return {
    id: profile.id,
    loader: 'fabric',
    loaderVersion,
    entry,
    vanilla,
    profile,
    mainClass: profile.mainClass,
    libraries: mergeLibraries(vanilla.libraries, profile.libraries),
    arguments: {
      jvm: [...(vanilla.arguments?.jvm || []), ...(profile.arguments?.jvm || [])],
      'default-user-jvm': vanilla.arguments?.['default-user-jvm'] || [],
      game: [...(vanilla.arguments?.game || []), ...(profile.arguments?.game || [])]
    },
    minecraftArguments: profile.minecraftArguments || vanilla.minecraftArguments || null
  };
}
