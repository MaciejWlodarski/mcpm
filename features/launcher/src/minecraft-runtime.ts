import type { AssetIndex, JavaInspection, LaunchMetadata, MinecraftRuntime, RuntimeOptions, VersionMetadata } from './types.js';
import { toError } from './errors.js';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { unzipSync } from 'fflate';
import {
  downloadFile,
  mapConcurrent,
  pathExists,
  resolveWithinDirectory
} from './downloads.js';
import {
  getLibraryArtifact,
  getLibraryNative,
  rulesAllow
} from './metadata.js';

const ASSET_OBJECT_URL = 'https://resources.download.minecraft.net';

function assertSafeArchivePath(entryName: string) {
  const normalized = path.normalize(entryName.replaceAll('/', path.sep));
  if (!entryName || path.isAbsolute(normalized) || normalized === '..' ||
      normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe path in native library: ${entryName}`);
  }
  return normalized;
}

function isExcludedNative(entryName: string, excludes: string[]) {
  const normalized = entryName.replaceAll('\\', '/');
  if (normalized.endsWith('/')) return true;
  if (normalized.toUpperCase().startsWith('META-INF/')) return true;
  return excludes.some(prefix => normalized.startsWith(prefix));
}

async function extractNativeJar(jarPath: string, nativesDirectory: string, excludes: string[] = []) {
  const archive = unzipSync(new Uint8Array(await fs.readFile(jarPath)));
  const extracted = [];
  for (const [entryName, contents] of Object.entries(archive)) {
    if (isExcludedNative(entryName, excludes)) continue;
    const destination = path.join(nativesDirectory, assertSafeArchivePath(entryName));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
    extracted.push(destination);
  }
  return extracted;
}

async function downloadLibraries(metadata: LaunchMetadata, launcherDirectory: string, options: RuntimeOptions) {
  const librariesDirectory = path.join(launcherDirectory, 'libraries');
  const allowedLibraries = metadata.libraries.filter(library => rulesAllow(library.rules, options));
  let completed = 0;
  options.onProgress?.({ phase: 'libraries', completed, total: allowedLibraries.length });

  const results = await mapConcurrent(allowedLibraries, options.concurrency || 10, async library => {
    const artifact = getLibraryArtifact(library);
    const artifactPath = resolveWithinDirectory(
      librariesDirectory,
      artifact.path,
      `library path for ${library.name}`
    );
    await downloadFile(artifact, artifactPath, options);

    const native = getLibraryNative(library, options);
    let nativeArchive = null;
    if (native) {
      const nativePath = resolveWithinDirectory(
        librariesDirectory,
        native.path,
        `native library path for ${library.name}`
      );
      await downloadFile(native, nativePath, options);
      nativeArchive = { path: nativePath, exclude: native.exclude };
    }
    completed += 1;
    options.onProgress?.({ phase: 'libraries', completed, total: allowedLibraries.length });
    return { artifactPath, nativeArchive };
  });
  return {
    classpath: results.map(result => result.artifactPath),
    nativeArchives: results.map(result => result.nativeArchive).filter((native): native is NonNullable<typeof native> => native !== null)
  };
}

async function downloadAssets(vanilla: VersionMetadata, launcherDirectory: string, gameDirectory: string, options: RuntimeOptions) {
  const assetsDirectory = path.join(launcherDirectory, 'assets');
  const assetIndex = vanilla.assetIndex;
  if (!assetIndex?.url || !assetIndex.id) {
    throw new Error(`Minecraft ${vanilla.id} does not provide an asset index.`);
  }
  const indexPath = resolveWithinDirectory(
    path.join(assetsDirectory, 'indexes'),
    `${assetIndex.id}.json`,
    'asset index id'
  );
  await downloadFile(assetIndex, indexPath, options);
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as AssetIndex;
  const objects = Object.entries(index.objects || {});
  let completed = 0;
  options.onProgress?.({ phase: 'assets', completed, total: objects.length });

  await mapConcurrent(objects, options.concurrency || 16, async ([logicalPath, object]) => {
    if (!/^[a-f0-9]{40}$/i.test(object.hash)) {
      throw new Error(`Invalid asset hash for ${logicalPath}: ${object.hash}`);
    }
    const objectPath = path.join(assetsDirectory, 'objects', object.hash.slice(0, 2), object.hash);
    await downloadFile({
      url: `${ASSET_OBJECT_URL}/${object.hash.slice(0, 2)}/${object.hash}`,
      sha1: object.hash,
      size: object.size
    }, objectPath, options);

    if (index.virtual || index.map_to_resources) {
      const relativePath = assertSafeArchivePath(logicalPath);
      const mappedPath = index.virtual
        ? resolveWithinDirectory(
            path.join(assetsDirectory, 'virtual'),
            path.join(assetIndex.id, relativePath),
            'virtual asset path'
          )
        : path.join(gameDirectory, 'resources', relativePath);
      if (!(await pathExists(mappedPath))) {
        await fs.mkdir(path.dirname(mappedPath), { recursive: true });
        await fs.copyFile(objectPath, mappedPath);
      }
    }
    completed += 1;
    options.onProgress?.({ phase: 'assets', completed, total: objects.length });
  });
  return { assetsDirectory, assetIndexId: assetIndex.id, assetIndexPath: indexPath };
}

async function prepareLogging(vanilla: VersionMetadata, launcherDirectory: string, options: RuntimeOptions) {
  const logging = vanilla.logging?.client;
  if (!logging?.file?.url) return { path: null, argument: null };
  const loggingPath = resolveWithinDirectory(
    path.join(launcherDirectory, 'log-configs'),
    logging.file.id,
    'logging configuration id'
  );
  await downloadFile(logging.file, loggingPath, options);
  return {
    path: loggingPath,
    argument: logging.argument?.replace('${path}', loggingPath) || null
  };
}

export function getLauncherDirectory(stateDirectory: string) {
  return path.join(stateDirectory, 'launcher');
}

export function getRuntimeMarkerPath(stateDirectory: string, runtimeId: string) {
  return resolveWithinDirectory(
    path.join(getLauncherDirectory(stateDirectory), 'versions'),
    path.join(runtimeId, 'runtime.json'),
    'runtime id'
  );
}

export async function prepareMinecraftRuntime(metadata: LaunchMetadata, stateDirectory: string, gameDirectory: string, options: RuntimeOptions = {}): Promise<MinecraftRuntime> {
  const launcherDirectory = getLauncherDirectory(stateDirectory);
  const versionDirectory = resolveWithinDirectory(
    path.join(launcherDirectory, 'versions'),
    metadata.id,
    'version id'
  );
  const clientJar = resolveWithinDirectory(
    versionDirectory,
    `${metadata.vanilla.id}.jar`,
    'Minecraft client id'
  );
  const clientDownload = metadata.vanilla.downloads?.client;
  if (!clientDownload?.url) {
    throw new Error(`Minecraft ${metadata.vanilla.id} does not provide a client download.`);
  }
  await downloadFile(clientDownload, clientJar, options);
  await fs.mkdir(versionDirectory, { recursive: true });
  await fs.writeFile(
    resolveWithinDirectory(versionDirectory, `${metadata.id}.json`, 'profile id'),
    JSON.stringify(metadata.profile, null, 2),
    'utf8'
  );

  const [{ classpath, nativeArchives }, assets, logging] = await Promise.all([
    downloadLibraries(metadata, launcherDirectory, options),
    downloadAssets(metadata.vanilla, launcherDirectory, gameDirectory, options),
    prepareLogging(metadata.vanilla, launcherDirectory, options)
  ]);

  const nativesDirectory = resolveWithinDirectory(
    path.join(launcherDirectory, 'natives'),
    path.join(metadata.id, `${options.osName || process.platform}-${options.arch || process.arch}`),
    'native runtime id'
  );
  await fs.mkdir(nativesDirectory, { recursive: true });
  const nativeFiles = [];
  for (const native of nativeArchives) {
    nativeFiles.push(...await extractNativeJar(native.path, nativesDirectory, native.exclude));
  }

  const uniqueClasspath = [...new Set([...classpath, clientJar])];
  const markerPath = getRuntimeMarkerPath(stateDirectory, metadata.id);
  const marker = {
    id: metadata.id,
    minecraftVersion: metadata.vanilla.id,
    loader: metadata.loader,
    loaderVersion: metadata.loaderVersion,
    javaComponent: metadata.vanilla.javaVersion?.component || null,
    javaMajorVersion: metadata.vanilla.javaVersion?.majorVersion || null,
    assetsDirectory: assets.assetsDirectory,
    assetIndexPath: assets.assetIndexPath,
    requiredFiles: [
      clientJar,
      assets.assetIndexPath,
      nativesDirectory,
      ...nativeFiles,
      ...uniqueClasspath,
      ...(logging.path ? [logging.path] : [])
    ]
  };

  return {
    launcherDirectory,
    versionDirectory,
    clientJar,
    classpath: uniqueClasspath,
    nativesDirectory,
    ...assets,
    logging,
    markerPath,
    marker
  };
}

export async function writePreparedRuntimeMarker(runtime: MinecraftRuntime, java: JavaInspection) {
  const marker = {
    ...runtime.marker,
    javaExecutable: java.executable,
    preparedAt: new Date().toISOString()
  };
  await fs.mkdir(path.dirname(runtime.markerPath), { recursive: true });
  const temporaryPath = `${runtime.markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(marker, null, 2), 'utf8');
    await fs.rename(temporaryPath, runtime.markerPath);
  } catch (errorCause) {
    const error = toError(errorCause);
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return marker;
}
