import type { DownloadDescriptor, RuntimeOptions } from './types.js';
import { toError } from './errors.js';
import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

export async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function sha1File(filePath: string) {
  const data = await fs.readFile(filePath);
  return createHash('sha1').update(data).digest('hex');
}

async function isCachedFileUsable(filePath: string, descriptor: DownloadDescriptor) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    if (Number.isFinite(descriptor.size) && stat.size !== descriptor.size) return false;
    if (descriptor.sha1 && descriptor.verifyExisting !== false) {
      return await sha1File(filePath) === descriptor.sha1.toLowerCase();
    }
    return true;
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function resolveWithinDirectory(rootDirectory: string, relativePath: string, label = 'path') {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`Invalid ${label}: ${relativePath || '<empty>'}`);
  }
  const root = path.resolve(rootDirectory);
  const destination = path.resolve(root, relativePath.replaceAll('/', path.sep));
  const relative = path.relative(root, destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)) {
    throw new Error(`Unsafe ${label}: ${relativePath}`);
  }
  return destination;
}

async function fetchBuffer(url: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'MCPM-Launcher/0.3.0' },
    redirect: 'follow'
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while downloading ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function downloadFile(descriptor: DownloadDescriptor, destination: string, options: RuntimeOptions = {}) {
  if (!descriptor?.url) throw new Error(`Missing download URL for ${destination}`);
  if (await isCachedFileUsable(destination, descriptor)) {
    return { path: destination, downloaded: false };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const retries = Number.isInteger(options.retries) ? options.retries! : 2;
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const buffer = await fetchBuffer(descriptor.url, fetchImpl);
      if (Number.isFinite(descriptor.size) && buffer.length !== descriptor.size) {
        throw new Error(
          `Size mismatch for ${descriptor.url}: expected ${descriptor.size}, received ${buffer.length}`
        );
      }
      if (descriptor.sha1) {
        const actualSha1 = createHash('sha1').update(buffer).digest('hex');
        if (actualSha1 !== descriptor.sha1.toLowerCase()) {
          throw new Error(
            `SHA-1 mismatch for ${descriptor.url}: expected ${descriptor.sha1}, received ${actualSha1}`
          );
        }
      }

      await fs.writeFile(temporaryPath, buffer);
      try {
        await fs.unlink(destination);
      } catch (errorCause) {
        const error = toError(errorCause);
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.rename(temporaryPath, destination);
      return { path: destination, downloaded: true };
    } catch (errorCause) {
      const error = toError(errorCause);
      lastError = error;
      try {
        await fs.unlink(temporaryPath);
      } catch (cleanupErrorCause) {
        const cleanupError = toError(cleanupErrorCause);
        if (cleanupError.code !== 'ENOENT') error.cleanupError ||= cleanupError;
      }
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export async function requestJson<T>(url: string, options: RuntimeOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'MCPM-Launcher/0.3.0', accept: 'application/json' },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} while requesting ${url}`);
  return response.json() as Promise<T>;
}

export async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
