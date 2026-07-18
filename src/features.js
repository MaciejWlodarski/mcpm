import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  getProjectRootForConfig,
  readConfig,
  readLock,
  resolveModsDir
} from './config.js';
import { getStateDirectory, resolveProjectRoot } from './projects.js';

const FEATURE_API_VERSION = 1;
const FEATURE_REGISTRY_FILENAME = 'features.json';
const FEATURE_CATALOG = Object.freeze({
  launcher: {
    packageName: '@mcpm/feature-launcher',
    packageSpec: '@mcpm/feature-launcher@latest'
  }
});

export function getFeatureDirectory() {
  return path.join(getStateDirectory(), 'features');
}

export function getFeatureRegistryPath() {
  return path.join(getFeatureDirectory(), FEATURE_REGISTRY_FILENAME);
}

function getInstalledPackageDirectory(packageName) {
  return path.join(getFeatureDirectory(), 'node_modules', ...packageName.split('/'));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readFeatureRegistry() {
  try {
    const parsed = JSON.parse(await fs.readFile(getFeatureRegistryPath(), 'utf8'));
    return {
      version: FEATURE_API_VERSION,
      features: parsed.features && typeof parsed.features === 'object' ? parsed.features : {}
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: FEATURE_API_VERSION, features: {} };
    throw new Error(`Failed to read the MCPM feature registry: ${error.message}`, { cause: error });
  }
}

async function writeFeatureRegistry(registry) {
  const registryPath = getFeatureRegistryPath();
  const temporaryPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(registryPath), { recursive: true });

  try {
    await fs.writeFile(temporaryPath, JSON.stringify(registry, null, 2), 'utf8');
    await fs.rename(temporaryPath, registryPath);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError ||= cleanupError;
    }
    throw new Error(`Failed to write the MCPM feature registry: ${error.message}`, { cause: error });
  }
}

async function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    process.env.APPDATA && path.join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    ),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    )
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function runNpm(argumentsList) {
  const npmCli = await findNpmCli();
  const executable = npmCli ? process.execPath : 'npm';
  const childArguments = npmCli ? [npmCli, ...argumentsList] : argumentsList;
  if (!npmCli && process.platform === 'win32') {
    throw new Error('npm-cli.js was not found. Install npm and try again.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, childArguments, {
      stdio: 'inherit',
      shell: false
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`npm exited with code ${code}`));
    });
  });
}

async function readFeaturePackage(packageName) {
  const packageDirectory = getInstalledPackageDirectory(packageName);
  const manifestPath = path.join(packageDirectory, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  if (manifest.name !== packageName) {
    throw new Error(`The installed package has an unexpected name: ${manifest.name}`);
  }
  if (manifest.mcpmFeature?.apiVersion !== FEATURE_API_VERSION || !manifest.mcpmFeature?.entry) {
    throw new Error(`Package ${packageName} does not support MCPM Feature API v${FEATURE_API_VERSION}`);
  }

  const entryPath = path.resolve(packageDirectory, manifest.mcpmFeature.entry);
  const relativeEntry = path.relative(packageDirectory, entryPath);
  if (relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) {
    throw new Error(`The ${packageName} entry point is outside the package directory`);
  }

  return { manifest, packageDirectory, entryPath };
}

async function getInstallSpec(featureName, source) {
  const catalogEntry = FEATURE_CATALOG[featureName];
  if (!catalogEntry) throw new Error(`Unknown MCPM feature: ${featureName}`);

  if (source) {
    const sourcePath = path.resolve(source);
    const manifest = JSON.parse(await fs.readFile(path.join(sourcePath, 'package.json'), 'utf8'));
    if (manifest.name !== catalogEntry.packageName) {
      throw new Error(
        `The source for feature ${featureName} must contain package ${catalogEntry.packageName}`
      );
    }
    if (manifest.mcpmFeature?.apiVersion !== FEATURE_API_VERSION || !manifest.mcpmFeature?.entry) {
      throw new Error(`The source for feature ${featureName} does not support MCPM Feature API v1`);
    }
    return sourcePath;
  }

  const developmentSource = fileURLToPath(new URL('../features/launcher', import.meta.url));
  if (featureName === 'launcher' && await pathExists(path.join(developmentSource, 'package.json'))) {
    return developmentSource;
  }

  return catalogEntry.packageSpec;
}

export async function installFeature(featureName, options = {}) {
  const catalogEntry = FEATURE_CATALOG[featureName];
  if (!catalogEntry) throw new Error(`Unknown MCPM feature: ${featureName}`);

  const installSpec = await getInstallSpec(featureName, options.source);
  const featureDirectory = getFeatureDirectory();
  await fs.mkdir(featureDirectory, { recursive: true });
  await runNpm([
    'install',
    '--prefix', featureDirectory,
    '--save-exact',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    installSpec
  ]);

  const { manifest } = await readFeaturePackage(catalogEntry.packageName);
  const registry = await readFeatureRegistry();
  registry.features[featureName] = {
    packageName: catalogEntry.packageName,
    version: manifest.version,
    installedAt: new Date().toISOString()
  };
  await writeFeatureRegistry(registry);

  return { name: featureName, ...registry.features[featureName] };
}

export async function uninstallFeature(featureName) {
  const registry = await readFeatureRegistry();
  const installed = registry.features[featureName];
  if (!installed) throw new Error(`Feature "${featureName}" is not installed`);
  const catalogEntry = FEATURE_CATALOG[featureName];
  if (!catalogEntry || installed.packageName !== catalogEntry.packageName) {
    throw new Error(`The registry entry for feature ${featureName} points to a disallowed package`);
  }

  await runNpm([
    'uninstall',
    '--prefix', getFeatureDirectory(),
    '--no-audit',
    '--no-fund',
    installed.packageName
  ]);
  delete registry.features[featureName];
  await writeFeatureRegistry(registry);
  return { name: featureName, ...installed };
}

export async function listFeatures() {
  const registry = await readFeatureRegistry();
  return Object.entries(FEATURE_CATALOG).map(([name, catalogEntry]) => ({
    name,
    packageName: catalogEntry.packageName,
    installed: Boolean(registry.features[name]),
    version: registry.features[name]?.version || null
  }));
}

function createFeatureApi() {
  return Object.freeze({
    version: FEATURE_API_VERSION,
    getStateDirectory,
    resolveProjectRoot,
    async getProjectContext() {
      const config = await readConfig();
      const projectRoot = getProjectRootForConfig(config);
      const lock = await readLock(projectRoot);
      return {
        projectRoot,
        config,
        lock,
        modsDir: resolveModsDir(config, projectRoot)
      };
    }
  });
}

export async function loadInstalledFeatures(program) {
  const registry = await readFeatureRegistry();
  const loaded = [];
  const failures = [];

  for (const [name, installed] of Object.entries(registry.features)) {
    try {
      const catalogEntry = FEATURE_CATALOG[name];
      if (!catalogEntry || installed.packageName !== catalogEntry.packageName) {
        throw new Error(`The registry entry for feature ${name} points to a disallowed package`);
      }
      const { manifest, entryPath } = await readFeaturePackage(installed.packageName);
      const module = await import(pathToFileURL(entryPath).href);
      if (typeof module.registerFeature !== 'function') {
        throw new Error(`Package ${installed.packageName} does not export registerFeature`);
      }
      await module.registerFeature({ program, api: createFeatureApi() });
      loaded.push({ name, version: manifest.version });
    } catch (error) {
      failures.push({ name, message: error.message });
    }
  }

  return { loaded, failures };
}
