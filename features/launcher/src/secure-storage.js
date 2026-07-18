import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

const CREDENTIAL_FILENAME = 'launcher-account.dpapi';

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

export function getCredentialPath(stateDirectory) {
  return path.join(stateDirectory, 'features', CREDENTIAL_FILENAME);
}

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
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

async function protect(value) {
  if (process.platform !== 'win32') {
    throw new Error('Secure launcher account storage is currently supported only on Windows.');
  }
  return runPowerShell(PROTECT_SCRIPT, value);
}

async function unprotect(value) {
  if (process.platform !== 'win32') {
    throw new Error('Secure launcher account storage is currently supported only on Windows.');
  }
  return runPowerShell(UNPROTECT_SCRIPT, value);
}

export async function saveSession(stateDirectory, session, options = {}) {
  const protectValue = options.protect || protect;
  const credentialPath = getCredentialPath(stateDirectory);
  const temporaryPath = `${credentialPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(credentialPath), { recursive: true });
  const encrypted = await protectValue(JSON.stringify(session));

  try {
    await fs.writeFile(temporaryPath, encrypted, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, credentialPath);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError ||= cleanupError;
    }
    throw error;
  }
}

export async function readSession(stateDirectory, options = {}) {
  const unprotectValue = options.unprotect || unprotect;
  try {
    const encrypted = await fs.readFile(getCredentialPath(stateDirectory), 'utf8');
    return JSON.parse(await unprotectValue(encrypted.trim()));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not read the saved launcher session: ${error.message}`, { cause: error });
  }
}

export async function clearSession(stateDirectory) {
  try {
    await fs.unlink(getCredentialPath(stateDirectory));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
