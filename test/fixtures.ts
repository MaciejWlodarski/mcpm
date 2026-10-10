import assert from 'node:assert/strict';
import type { InstalledMod, InstallPlan, Lockfile, ProjectConfig } from '../dist/src/types.js';
import type {
  FeatureApi, JavaInspection, KeychainEntry, LaunchMetadata, MinecraftRuntime,
  MinecraftSession, ProjectContext, VersionMetadata
} from '../features/launcher/dist/types.js';

type SessionOverrides = Omit<Partial<MinecraftSession>, 'profile' | 'microsoft' | 'minecraft'> & {
  profile?: Partial<MinecraftSession['profile']>;
  microsoft?: Partial<MinecraftSession['microsoft']>;
  minecraft?: Partial<MinecraftSession['minecraft']>;
};

export function sessionFixture(overrides: SessionOverrides = {}): MinecraftSession {
  return {
    version: 1, clientId: 'client-id', savedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
    profile: { id: 'uuid', name: 'Alex', skins: [], capes: [], ...overrides.profile },
    microsoft: { refreshToken: 'refresh-token', expiresAt: '2026-01-02T00:00:00.000Z', ...overrides.microsoft },
    minecraft: { accessToken: 'token', xuid: 'xuid', expiresAt: '2026-01-02T00:00:00.000Z', ...overrides.minecraft }
  };
}

export function keychainFixture(overrides: Partial<KeychainEntry>): KeychainEntry {
  return {
    setPassword: () => assert.fail('Unexpected Keychain write'),
    getPassword: () => assert.fail('Unexpected Keychain read'),
    deleteCredential: () => assert.fail('Unexpected Keychain deletion'),
    ...overrides
  };
}

export function featureApiFixture(overrides: Partial<FeatureApi>): FeatureApi {
  return {
    version: 2,
    getStateDirectory: () => assert.fail('Unexpected state directory lookup'),
    listProjects: async () => assert.fail('Unexpected profile listing'),
    setActiveProject: async () => assert.fail('Unexpected profile selection'),
    getProjectContext: async () => assert.fail('Unexpected profile lookup'),
    ...overrides
  };
}

export function configFixture(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods', mods: {}, ...overrides };
}

export function lockFixture(overrides: Omit<Partial<Lockfile>, 'installed'> & {
  installed?: Record<string, Partial<InstalledMod>>;
} = {}): Lockfile {
  return {
    minecraftVersion: '1.21.1', loader: 'fabric', ...overrides,
    installed: Object.fromEntries(Object.entries(overrides.installed || {}).map(([id, mod]) => [id, {
      title: id, slug: id, version: '1.0.0', filename: `${id}.jar`, ...mod
    }]))
  };
}

export function planFixture(roots: string[]): InstallPlan {
  return {
    rootProjectIds: new Set(roots), versionToProject: new Map(),
    allowBeta: false, items: new Map()
  };
}

export function projectContextFixture(overrides: Omit<Partial<ProjectContext>, 'config'> & {
  config?: Partial<ProjectContext['config']>;
} = {}): ProjectContext {
  return {
    projectRoot: 'profile', modsDir: 'profile/mods', lock: { installed: {} }, ...overrides,
    config: { minecraftVersion: '1.21.1', loader: 'fabric', ...overrides.config }
  };
}

export function versionMetadataFixture(overrides: Partial<VersionMetadata> = {}): VersionMetadata {
  return { id: '1.21.1', mainClass: 'Main', ...overrides };
}

export function launchMetadataFixture(overrides: Omit<Partial<LaunchMetadata>, 'vanilla' | 'profile'> & {
  vanilla?: Partial<VersionMetadata>;
  profile?: Partial<VersionMetadata>;
} = {}): LaunchMetadata {
  return {
    id: 'test', loader: 'fabric', loaderVersion: null,
    entry: { id: '1.21.1', url: 'https://test/version.json' },
    mainClass: 'Main', libraries: [], arguments: null, minecraftArguments: null,
    ...overrides,
    vanilla: versionMetadataFixture(overrides.vanilla),
    profile: versionMetadataFixture(overrides.profile)
  };
}

export function javaFixture(overrides: Partial<JavaInspection> = {}): JavaInspection {
  return { available: true, executable: 'java', version: 'Java 21', majorVersion: 21, ...overrides };
}

export function runtimeFixture(overrides: Omit<Partial<MinecraftRuntime>, 'logging'> & {
  logging?: Partial<MinecraftRuntime['logging']>;
} = {}): MinecraftRuntime {
  return {
    launcherDirectory: 'launcher', versionDirectory: 'launcher/versions/test',
    clientJar: 'client.jar', classpath: [], nativesDirectory: 'natives',
    assetsDirectory: 'assets', assetIndexId: 'test', assetIndexPath: 'assets/indexes/test.json',
    markerPath: 'launcher/versions/test/runtime.json',
    marker: {
      id: 'test', minecraftVersion: '1.21.1', loader: 'fabric', loaderVersion: null,
      javaComponent: null, javaMajorVersion: 21, assetsDirectory: 'assets',
      assetIndexPath: 'assets/indexes/test.json', requiredFiles: []
    },
    ...overrides,
    logging: { path: null, argument: null, ...overrides.logging }
  };
}

export function nextResponse(responses: Response[]): Response {
  const response = responses.shift();
  assert.ok(response, 'Unexpected extra fetch request');
  return response;
}
