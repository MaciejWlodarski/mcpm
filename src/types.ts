import type { Command } from 'commander';

export interface LauncherConfig {
  javaPath?: string;
  memory?: { min?: string; max?: string };
  resolution?: { width?: number; height?: number };
  jvmArgs?: string[];
}

export interface ProjectConfig {
  name?: string;
  minecraftVersion: string;
  loader: string;
  loaderVersion?: string;
  modsDir: string;
  mods: Record<string, string>;
  allowBeta?: boolean;
  gameDir?: string;
  javaPath?: string;
  launcher?: LauncherConfig;
}

export interface InstalledMod {
  title: string;
  slug: string;
  version: string;
  versionId?: string;
  filename: string;
  dependencies?: string[];
  isDependency?: boolean;
}

export interface Lockfile {
  minecraftVersion: string;
  loader: string;
  allowBeta?: boolean;
  installed: Record<string, InstalledMod>;
}

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description?: string;
}

export interface ModrinthFile {
  filename: string;
  url: string;
  primary?: boolean;
  hashes?: Record<string, string>;
  size?: number;
}

export interface ModrinthDependency {
  project_id?: string | null;
  version_id?: string | null;
  dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded';
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: 'release' | 'beta' | 'alpha';
  game_versions?: string[];
  loaders?: string[];
  dependencies?: ModrinthDependency[];
  files?: ModrinthFile[];
}

export interface SearchHit {
  author: string;
  project_id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
}

export interface GameVersion {
  version: string;
  version_type: string;
  date: string;
  major: boolean;
}

export interface ApiServices {
  getProject(idOrSlug: string): Promise<ModrinthProject>;
  getProjectVersions(projectId: string, minecraftVersion?: string, loader?: string): Promise<ModrinthVersion[]>;
  getVersion(versionId: string): Promise<ModrinthVersion>;
  getProjects?(idsOrSlugs: string[]): Promise<ModrinthProject[]>;
  getVersions?(versionIds: string[]): Promise<ModrinthVersion[]>;
}

export interface InstallOptions {
  beta?: boolean;
  pinnedVersions?: Record<string, string>;
}

export interface PlanItem {
  project: ModrinthProject;
  version: ModrinthVersion;
  dependencies: string[];
  isDependency: boolean;
}

export interface InstallPlan {
  items: Map<string, PlanItem>;
  rootProjectIds: Set<string>;
  versionToProject: Map<string, string>;
  allowBeta: boolean;
}

export interface ApplyOptions {
  projectRoot?: string;
  previousLock?: Lockfile;
  persistedConfig?: ProjectConfig;
  persistedLock?: Lockfile;
  removeAllPrevious?: boolean;
}

export interface InstallOverrides extends ApplyOptions {
  config?: ProjectConfig;
  lock?: Lockfile;
  services?: Partial<ApiServices>;
}

export type CheckResult =
  | { compatible: true; plan: InstallPlan; failures: [] }
  | { compatible: false; plan: InstallPlan | null; failures: { slug: string | null; message: string }[] };

export interface ProjectRegistry {
  version: number;
  active: string | null;
  projects: Record<string, { path: string; registeredAt: string }>;
}

export interface RegisteredProject {
  name: string;
  path: string;
  active: boolean;
  available?: boolean;
}

export interface ProjectContext {
  projectRoot: string;
  config: ProjectConfig;
  lock: Lockfile;
  modsDir: string;
}

export interface FeatureApi {
  version: number;
  getStateDirectory(): string;
  listProjects(): Promise<RegisteredProject[]>;
  resolveProjectRoot(): Promise<string>;
  setActiveProject(reference: string): Promise<RegisteredProject>;
  getProjectContext(reference?: string | null): Promise<ProjectContext>;
}

export interface FeatureModule {
  registerFeature(context: { program: Command; api: FeatureApi }): void | Promise<void>;
}

export interface FeatureRegistry {
  version: number;
  features: Record<string, { packageName: string; version: string; installedAt: string }>;
}

export interface FeatureManifest {
  name: string;
  version: string;
  mcpmFeature: { apiVersion: number; entry: string };
}
