import type { LauncherError } from './errors.js';
import type { KeychainEntry, MinecraftSession, StorageOptions } from './types.js';
import { toError } from './errors.js';
import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';

const WINDOWS_CREDENTIAL_FILENAME = 'launcher-account.dpapi';
const MACOS_CREDENTIAL_FILENAME = 'launcher-account.json';
const STORAGE_PREFERENCE_FILENAME = 'launcher-storage.json';
const MACOS_KEYCHAIN_SERVICE = 'dev.mcpm.launcher';
const MACOS_USER_FILE_PREFIX = 'macos-user-file:v1\n';
const MACOS_STORAGES = new Set(['keychain', 'file']);

const PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$value = [Console]::In.ReadToEnd()',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($value)',
  '$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($encrypted))'
].join('; ');

const UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$value = [Console]::In.ReadToEnd()',
  '$bytes = [Convert]::FromBase64String($value)',
  '$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($decrypted))'
].join('; ');

export function getCredentialPath(stateDirectory: string) {
  if (process.platform === 'darwin') {
    return path.join(stateDirectory, 'credentials', MACOS_CREDENTIAL_FILENAME);
  }
  return path.join(stateDirectory, 'features', WINDOWS_CREDENTIAL_FILENAME);
}

function getStoragePreferencePath(stateDirectory: string) {
  return path.join(stateDirectory, 'credentials', STORAGE_PREFERENCE_FILENAME);
}

function getLegacyMacOSCredentialPath(stateDirectory: string) {
  return path.join(stateDirectory, 'features', WINDOWS_CREDENTIAL_FILENAME);
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

async function writePrivateFile(filePath: string, value: string, privateDirectory = false) {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: privateDirectory ? 0o700 : 0o755 });
  if (privateDirectory) await fs.chmod(directory, 0o700);

  try {
    await fs.writeFile(temporaryPath, value, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (errorCause) {
    const error = toError(errorCause);
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupErrorCause) {
      const cleanupError = toError(cleanupErrorCause);
      if (cleanupError.code !== 'ENOENT') error.cleanupError ||= cleanupError;
    }
    throw error;
  }
}

async function unlinkIfPresent(filePath: string) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function macOSKeychainAccount(stateDirectory: string) {
  const digest = createHash('sha256').update(path.resolve(stateDirectory)).digest('hex');
  return `launcher-session-${digest.slice(0, 24)}`;
}

async function keychainEntry(stateDirectory: string, options: StorageOptions = {}): Promise<KeychainEntry> {
  const account = macOSKeychainAccount(stateDirectory);
  if (options.createKeychainEntry) {
    return options.createKeychainEntry(MACOS_KEYCHAIN_SERVICE, account);
  }
  // Windows DPAPI and the explicit file fallback do not require a native binding.
  const { Entry } = await import('@napi-rs/keyring');
  return new Entry(MACOS_KEYCHAIN_SERVICE, account);
}

function keychainError(action: string, error: Error) {
  const wrapped: LauncherError = new Error(
    `The macOS Keychain could not ${action} the launcher session: ${error.message}. ` +
    'Fix the login Keychain and try again, or explicitly choose user-only file storage with ' +
    '"mcpm launcher login --storage=file".',
    { cause: error }
  );
  wrapped.code = 'MCPM_KEYCHAIN_UNAVAILABLE';
  return wrapped;
}

async function readStoragePreference(stateDirectory: string, requestedStorage?: string): Promise<string> {
  if (requestedStorage) {
    if (!MACOS_STORAGES.has(requestedStorage)) {
      throw new Error(`Unsupported launcher account storage: ${requestedStorage}`);
    }
    return requestedStorage;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(getStoragePreferencePath(stateDirectory), 'utf8')) as { storage: string };
    if (!MACOS_STORAGES.has(parsed.storage)) {
      throw new Error(`Unsupported saved launcher account storage: ${parsed.storage}`);
    }
    return parsed.storage;
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code !== 'ENOENT') {
      const wrapped: LauncherError = new Error(
        `Could not read the launcher storage preference: ${error.message}. ` +
        'Choose a backend explicitly with "mcpm launcher login --storage=keychain" ' +
        'or "mcpm launcher login --storage=file".',
        { cause: error }
      );
      wrapped.code = 'MCPM_STORAGE_PREFERENCE_UNREADABLE';
      throw wrapped;
    }
    if (await pathExists(getCredentialPath(stateDirectory))) return 'file';
    if (await pathExists(getLegacyMacOSCredentialPath(stateDirectory))) return 'file';
    return 'keychain';
  }
}

async function writeStoragePreference(stateDirectory: string, storage: string) {
  await writePrivateFile(
    getStoragePreferencePath(stateDirectory),
    `${JSON.stringify({ storage })}\n`,
    true
  );
}

function protectMacOSFile(value: string) {
  return `${MACOS_USER_FILE_PREFIX}${value}`;
}

function unprotectMacOSFile(value: string) {
  if (!value.startsWith(MACOS_USER_FILE_PREFIX)) {
    throw new Error('The saved MCPM launcher session has an unsupported format.');
  }
  return value.slice(MACOS_USER_FILE_PREFIX.length);
}

async function saveMacOSSession(stateDirectory: string, session: MinecraftSession, options: StorageOptions) {
  const storage = await readStoragePreference(stateDirectory, options.storage);
  if (storage === 'file') {
    await writePrivateFile(
      getCredentialPath(stateDirectory),
      protectMacOSFile(JSON.stringify(session)),
      true
    );
    await writeStoragePreference(stateDirectory, storage);
    await unlinkIfPresent(getLegacyMacOSCredentialPath(stateDirectory));
    try {
      (await keychainEntry(stateDirectory, options)).deleteCredential();
    } catch {
      // The explicit fallback must remain usable when the login Keychain is unavailable.
    }
    return storage;
  }

  try {
    (await keychainEntry(stateDirectory, options)).setPassword(JSON.stringify(session));
  } catch (errorCause) {
    const error = toError(errorCause);
    throw keychainError('save', error);
  }
  await writeStoragePreference(stateDirectory, storage);
  await unlinkIfPresent(getCredentialPath(stateDirectory));
  await unlinkIfPresent(getLegacyMacOSCredentialPath(stateDirectory));
  return storage;
}

async function readMacOSSession(stateDirectory: string, options: StorageOptions): Promise<MinecraftSession | null> {
  const storage = await readStoragePreference(stateDirectory, options.storage);
  if (storage === 'file') {
    try {
      const currentPath = getCredentialPath(stateDirectory);
      const filePath = await pathExists(currentPath)
        ? currentPath
        : getLegacyMacOSCredentialPath(stateDirectory);
      const stored = await fs.readFile(filePath, 'utf8');
      return JSON.parse(unprotectMacOSFile(stored));
    } catch (errorCause) {
      const error = toError(errorCause);
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  let stored;
  try {
    stored = (await keychainEntry(stateDirectory, options)).getPassword();
  } catch (errorCause) {
    const error = toError(errorCause);
    throw keychainError('read', error);
  }
  return stored == null ? null : JSON.parse(stored);
}

async function clearMacOSSession(stateDirectory: string, options: StorageOptions) {
  const storage = await readStoragePreference(stateDirectory, options.storage);
  let removed = false;
  if (storage === 'file') {
    removed = await unlinkIfPresent(getCredentialPath(stateDirectory));
    removed = await unlinkIfPresent(getLegacyMacOSCredentialPath(stateDirectory)) || removed;
    try {
      removed = Boolean((await keychainEntry(stateDirectory, options)).deleteCredential()) || removed;
    } catch {
      // A broken Keychain must not prevent removal of an explicitly selected file session.
    }
  } else {
    try {
      removed = Boolean((await keychainEntry(stateDirectory, options)).deleteCredential());
    } catch (errorCause) {
      const error = toError(errorCause);
      throw keychainError('delete', error);
    }
    removed = await unlinkIfPresent(getCredentialPath(stateDirectory)) || removed;
    removed = await unlinkIfPresent(getLegacyMacOSCredentialPath(stateDirectory)) || removed;
  }
  // Keep the selected backend: a failed Keychain cleanup must not resurrect an
  // older Keychain session after a file-backed account has been signed out.
  await writeStoragePreference(stateDirectory, storage);
  return removed;
}

export async function saveSession(stateDirectory: string, session: MinecraftSession, options: StorageOptions = {}) {
  if (options.protect) {
    await writePrivateFile(
      getCredentialPath(stateDirectory),
      await options.protect(JSON.stringify(session)),
      process.platform === 'darwin'
    );
    return;
  }
  if (process.platform === 'darwin') {
    return saveMacOSSession(stateDirectory, session, options);
  }
  if (process.platform !== 'win32') {
    throw new Error('Launcher account storage is currently supported only on Windows and macOS.');
  }
  await writePrivateFile(
    getCredentialPath(stateDirectory),
    await runPowerShell(PROTECT_SCRIPT, JSON.stringify(session))
  );
}

export async function readSession(stateDirectory: string, options: StorageOptions = {}): Promise<MinecraftSession | null> {
  try {
    if (options.unprotect) {
      const stored = await fs.readFile(getCredentialPath(stateDirectory), 'utf8');
      return JSON.parse(await options.unprotect(stored));
    }
    if (process.platform === 'darwin') return await readMacOSSession(stateDirectory, options);
    if (process.platform !== 'win32') {
      throw new Error('Launcher account storage is currently supported only on Windows and macOS.');
    }
    const encrypted = await fs.readFile(getCredentialPath(stateDirectory), 'utf8');
    return JSON.parse(await runPowerShell(UNPROTECT_SCRIPT, encrypted.trim()));
  } catch (errorCause) {
    const error = toError(errorCause);
    if (error.code === 'ENOENT') return null;
    if (['MCPM_KEYCHAIN_UNAVAILABLE', 'MCPM_STORAGE_PREFERENCE_UNREADABLE'].includes(error.code || '')) {
      throw error;
    }
    throw new Error(`Could not read the saved launcher session: ${error.message}`, { cause: error });
  }
}

export async function clearSession(stateDirectory: string, options: StorageOptions = {}) {
  if (process.platform === 'darwin') return clearMacOSSession(stateDirectory, options);
  return unlinkIfPresent(getCredentialPath(stateDirectory));
}
