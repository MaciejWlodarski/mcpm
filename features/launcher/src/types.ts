import type { Command } from 'commander';

// The launcher is published separately. This is the structural Feature API
// contract it consumes; it has no runtime dependency on the MCPM CLI package.
export interface ProfileConfig {
  minecraftVersion: string;
  loader: string;
  loaderVersion?: string;
  gameDir?: string;
  javaPath?: string;
  launcher?: {
    javaPath?: string;
    memory?: { min?: string; max?: string };
    resolution?: { width?: number; height?: number };
    jvmArgs?: string[];
  };
}

export interface ProjectContext {
  projectRoot: string;
  config: ProfileConfig;
  modsDir: string;
  lock: { installed: Record<string, unknown> };
}

export interface FeatureApi {
  version: number;
  getStateDirectory(): string;
  listProjects(): Promise<{ name: string; path: string; active: boolean; available?: boolean }[]>;
  setActiveProject(reference: string): Promise<{ name: string; path: string; active: boolean }>;
  getProjectContext(reference?: string | null): Promise<ProjectContext>;
}

export interface FeatureRegistration { program: Command; api: FeatureApi }

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface MicrosoftToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface AuthOptions {
  clientId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<unknown>;
  now?: () => number;
  onDeviceCode?: (deviceCode: DeviceCode) => void | Promise<void>;
}

export interface MinecraftProfile {
  id: string;
  name: string;
  skins: unknown[];
  capes: unknown[];
}

export interface MinecraftSession {
  version: number;
  clientId: string;
  savedAt: string;
  microsoft: { refreshToken?: string; expiresAt: string };
  minecraft: { accessToken: string; xuid: string; expiresAt: string };
  profile: MinecraftProfile;
}

export interface KeychainEntry {
  setPassword(value: string): unknown;
  getPassword(): string | null | undefined;
  deleteCredential(): unknown;
}

export interface StorageOptions {
  storage?: string;
  createKeychainEntry?: (service: string, account: string) => KeychainEntry | Promise<KeychainEntry>;
  protect?: (value: string) => string | Promise<string>;
  unprotect?: (value: string) => string | Promise<string>;
}

export interface Progress { phase: string; completed: number; total: number }

export interface DownloadDescriptor {
  url: string;
  sha1?: string;
  size?: number;
  verifyExisting?: boolean;
}

export interface Rule {
  action: 'allow' | 'disallow';
  os?: { name?: string; arch?: string; version?: string; versionRange?: { min?: string; max?: string } };
  features?: Record<string, boolean>;
}

export interface RuleOptions {
  osName?: string;
  arch?: string;
  osVersion?: string;
  features?: Record<string, boolean>;
}

export interface RuntimeOptions extends RuleOptions {
  fetchImpl?: typeof fetch;
  retries?: number;
  concurrency?: number;
  onProgress?: (progress: Progress) => void;
  platform?: string;
  java?: string;
  javaPath?: string;
  projectRoot?: string;
  downloadJava?: boolean;
  inspectJava?: (executable: string) => JavaInspection;
}

export interface LaunchOptions extends RuntimeOptions {
  prepareOnly?: boolean;
  dryRun?: boolean;
  detach?: boolean;
  memory?: string;
  width?: number;
  height?: number;
  server?: string;
}

export type ArgumentEntry = string | { rules?: Rule[]; value: string | string[] };
export interface VersionArguments {
  jvm?: ArgumentEntry[];
  'default-user-jvm'?: ArgumentEntry[];
  game?: ArgumentEntry[];
}

export interface LibraryArtifact extends DownloadDescriptor { path: string }
export interface Library {
  name: string;
  url?: string;
  sha1?: string;
  size?: number;
  rules?: Rule[];
  natives?: Record<string, string>;
  extract?: { exclude?: string[] };
  downloads?: {
    artifact?: LibraryArtifact;
    classifiers?: Record<string, LibraryArtifact>;
  };
}

export interface VersionEntry { id: string; url: string }
export interface VersionMetadata {
  id: string;
  type?: string;
  mainClass: string;
  libraries?: Library[];
  arguments?: VersionArguments;
  minecraftArguments?: string;
  javaVersion?: { majorVersion: number; component: string };
  downloads?: { client?: DownloadDescriptor };
  assetIndex?: DownloadDescriptor & { id: string };
  logging?: { client?: { file: DownloadDescriptor & { id: string }; argument?: string } };
}

export interface LaunchMetadata {
  id: string;
  loader: string;
  loaderVersion: string | null;
  entry: VersionEntry;
  vanilla: VersionMetadata;
  profile: VersionMetadata;
  mainClass: string;
  libraries: Library[];
  arguments: VersionArguments | null;
  minecraftArguments: string | null;
}

export interface JavaInspection {
  available: boolean;
  executable: string;
  version: string | null;
  majorVersion: number | null;
}

export interface ResolvedJava extends JavaInspection {
  source: 'configured' | 'system' | 'mojang';
  runtimeDirectory?: string;
}

export interface RuntimeMarker {
  id: string;
  minecraftVersion: string;
  loader: string;
  loaderVersion: string | null;
  javaComponent: string | null;
  javaMajorVersion: number | null;
  assetsDirectory: string;
  assetIndexPath: string;
  requiredFiles: string[];
}

export interface PreparedMarker extends RuntimeMarker {
  javaExecutable: string;
  preparedAt: string;
}

export interface MinecraftRuntime {
  launcherDirectory: string;
  versionDirectory: string;
  clientJar: string;
  classpath: string[];
  nativesDirectory: string;
  assetsDirectory: string;
  assetIndexId: string;
  assetIndexPath: string;
  logging: { path: string | null; argument: string | null };
  markerPath: string;
  marker: RuntimeMarker;
}

export interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>;
  virtual?: boolean;
  map_to_resources?: boolean;
}

export interface JavaRuntimeEntry {
  manifest: DownloadDescriptor;
  version: { name: string };
}

export type JavaFile =
  | { type: 'directory' }
  | { type: 'file'; executable?: boolean; downloads?: { raw?: DownloadDescriptor } }
  | { type: 'link'; target: string };

export interface LauncherServices {
  readSession?: typeof import('./secure-storage.js').readSession;
  saveSession?: typeof import('./secure-storage.js').saveSession;
  createSession?: typeof import('./auth.js').createMinecraftSession;
}
