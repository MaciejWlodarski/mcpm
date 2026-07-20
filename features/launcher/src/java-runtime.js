import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  downloadFile,
  mapConcurrent,
  pathExists,
  requestJson,
  resolveWithinDirectory
} from './downloads.js';

export const JAVA_RUNTIME_MANIFEST_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/' +
  '2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

export function getJavaPlatform() {
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') return 'windows-arm64';
    return process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  }
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return 'linux-arm64';
    return process.arch === 'ia32' ? 'linux-i386' : 'linux';
  }
  throw new Error(`Automatic Java installation is not supported on ${process.platform}.`);
}

function javaExecutableIn(directory) {
  return path.join(directory, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

function normalizeJavaCandidate(candidate, baseDirectory = process.cwd()) {
  if (!candidate) return null;
  const resolved = path.resolve(baseDirectory, candidate);
  if (/javaw?(\.exe)?$/i.test(path.basename(resolved))) return resolved;
  return javaExecutableIn(resolved);
}

function resolveSafeLinkTarget(runtimeDirectory, destination, target) {
  if (typeof target !== 'string' || !target) {
    throw new Error('A Java runtime symbolic link has an empty target.');
  }
  const resolvedTarget = path.resolve(path.dirname(destination), target);
  const relative = path.relative(path.resolve(runtimeDirectory), resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Java runtime symbolic link target: ${target}`);
  }
  return target;
}

export function inspectJava(executable) {
  const result = spawnSync(executable, ['-version'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return { available: false, executable, version: null, majorVersion: null };
  }
  const output = `${result.stderr || ''}${result.stdout || ''}`;
  const firstLine = output.split(/\r?\n/)[0].trim();
  const match = output.match(/version\s+"([^"]+)"/i) || output.match(/openjdk\s+([0-9][^\s]*)/i);
  const version = match?.[1] || firstLine;
  const parts = version.split(/[._+-]/);
  const majorVersion = Number(parts[0] === '1' ? parts[1] : parts[0]);
  return {
    available: true,
    executable,
    version: firstLine,
    majorVersion: Number.isFinite(majorVersion) ? majorVersion : null
  };
}

function assertSafeManifestPath(relativePath) {
  const normalized = path.normalize(relativePath);
  if (!relativePath || path.isAbsolute(normalized) || normalized === '..' ||
      normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe Java runtime path in Mojang manifest: ${relativePath}`);
  }
  return normalized;
}

async function writeRuntimeMarker(runtimeDirectory, marker) {
  await fs.writeFile(
    path.join(runtimeDirectory, 'runtime.json'),
    JSON.stringify(marker, null, 2),
    'utf8'
  );
}

export async function installJavaRuntime(component, stateDirectory, options = {}) {
  const platform = options.platform || getJavaPlatform();
  const allRuntimes = await requestJson(JAVA_RUNTIME_MANIFEST_URL, options);
  const runtime = allRuntimes[platform]?.[component]?.[0];
  if (!runtime?.manifest?.url) {
    throw new Error(`Mojang does not provide Java component ${component} for ${platform}.`);
  }

  const runtimeDirectory = resolveWithinDirectory(
    path.join(stateDirectory, 'launcher', 'java'),
    path.join(component, runtime.version.name, platform),
    'Java runtime id'
  );
  const markerPath = path.join(runtimeDirectory, 'runtime.json');
  if (await pathExists(markerPath)) {
    try {
      const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
      const executable = resolveWithinDirectory(
        runtimeDirectory,
        marker.executableRelativePath,
        'Java executable path'
      );
      if (await pathExists(executable)) {
        return { executable, runtimeDirectory, version: runtime.version.name, downloaded: false };
      }
    } catch {
      // An incomplete or legacy marker is repaired from the official manifest below.
    }
  }

  const manifest = await requestJson(runtime.manifest.url, options);
  const entries = Object.entries(manifest.files || {});
  let completed = 0;
  options.onProgress?.({ phase: 'java', completed, total: entries.length });

  await mapConcurrent(entries, options.concurrency || 12, async ([relativePath, entry]) => {
    const safePath = assertSafeManifestPath(relativePath);
    const destination = path.join(runtimeDirectory, safePath);
    if (entry.type === 'directory') {
      await fs.mkdir(destination, { recursive: true });
    } else if (entry.type === 'file') {
      if (!entry.downloads?.raw) {
        throw new Error(`Missing raw download for Java runtime file ${relativePath}.`);
      }
      await downloadFile(entry.downloads.raw, destination, options);
      if (entry.executable && process.platform !== 'win32') await fs.chmod(destination, 0o755);
    } else if (entry.type === 'link') {
      if (process.platform === 'win32') {
        throw new Error(`Unsupported symbolic link in Windows Java runtime: ${relativePath}`);
      }
      const target = resolveSafeLinkTarget(runtimeDirectory, destination, entry.target);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try {
        await fs.symlink(target, destination);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } else {
      throw new Error(`Unknown Java runtime entry type: ${entry.type}`);
    }
    completed += 1;
    options.onProgress?.({ phase: 'java', completed, total: entries.length });
  });

  const executableEntry = entries.find(([relativePath, entry]) =>
    entry.type === 'file' && entry.executable && /(^|[\\/])bin[\\/]java(?:\.exe)?$/i.test(relativePath)
  );
  if (!executableEntry) {
    throw new Error(`Mojang Java component ${component} does not contain a Java executable.`);
  }
  const executableRelativePath = assertSafeManifestPath(executableEntry[0]);
  const executable = resolveWithinDirectory(
    runtimeDirectory,
    executableRelativePath,
    'Java executable path'
  );

  await writeRuntimeMarker(runtimeDirectory, {
    component,
    platform,
    version: runtime.version.name,
    manifestSha1: runtime.manifest.sha1,
    executableRelativePath,
    installedAt: new Date().toISOString()
  });
  return { executable, runtimeDirectory, version: runtime.version.name, downloaded: true };
}

export async function resolveJava(versionMetadata, config, stateDirectory, options = {}) {
  const inspect = options.inspectJava || inspectJava;
  const requiredMajor = Number(versionMetadata.javaVersion?.majorVersion) || 8;
  const explicitCandidate = options.java || options.javaPath ||
    config.launcher?.javaPath || config.javaPath;
  if (explicitCandidate) {
    const baseDirectory = options.java || options.javaPath
      ? process.cwd()
      : options.projectRoot || process.cwd();
    const inspected = inspect(normalizeJavaCandidate(explicitCandidate, baseDirectory));
    if (!inspected.available) {
      throw new Error(`Configured Java executable was not found: ${inspected.executable}`);
    }
    if (inspected.majorVersion !== null && inspected.majorVersion < requiredMajor) {
      throw new Error(
        `Minecraft ${config.minecraftVersion} requires Java ${requiredMajor}, but the configured ` +
        `runtime is Java ${inspected.majorVersion}.`
      );
    }
    return { ...inspected, source: 'configured' };
  }

  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(javaExecutableIn(process.env.JAVA_HOME));
  candidates.push('java');
  for (const candidate of [...new Set(candidates)]) {
    const inspected = inspect(candidate);
    if (inspected.available && inspected.majorVersion === requiredMajor) {
      return { ...inspected, source: 'system' };
    }
  }

  if (options.downloadJava === false) {
    throw new Error(
      `Minecraft ${config.minecraftVersion} requires Java ${requiredMajor}. ` +
      'Install it, configure launcher.javaPath, or allow MCPM to download the Mojang runtime.'
    );
  }
  const component = versionMetadata.javaVersion?.component || 'jre-legacy';
  const installed = await installJavaRuntime(component, stateDirectory, options);
  const inspected = inspect(installed.executable);
  if (!inspected.available) {
    throw new Error(`Downloaded Java runtime could not be started: ${installed.executable}`);
  }
  return { ...inspected, source: 'mojang', runtimeDirectory: installed.runtimeDirectory };
}
