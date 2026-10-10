import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  exchangeMicrosoftTokenForMinecraft,
  MICROSOFT_SCOPES,
  pollForMicrosoftToken,
  requestDeviceCode
} from '../features/launcher/dist/auth.js';
import {
  clearSession,
  getCredentialPath,
  readSession,
  saveSession
} from '../features/launcher/dist/secure-storage.js';

import { toError } from '../features/launcher/dist/errors.js';
import { keychainFixture, nextResponse, sessionFixture } from './fixtures.js';

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('device code flow uses personal accounts and Xbox Live scopes', async () => {
  let request: { url: string; options?: RequestInit } | undefined;
  const deviceCode = await requestDeviceCode({
    clientId: 'client-id',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse({
        device_code: 'device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://microsoft.com/link',
        expires_in: 900,
        interval: 5
      });
    }
  });

  assert.ok(request);
  assert.match(request.url, /\/consumers\/oauth2\/v2\.0\/devicecode$/);
  assert.equal(new URLSearchParams(String(request.options?.body)).get('client_id'), 'client-id');
  assert.equal(new URLSearchParams(String(request.options?.body)).get('scope'), MICROSOFT_SCOPES);
  assert.equal(deviceCode.user_code, 'ABCD-EFGH');
});

test('polling waits for code approval and returns a Microsoft token', async () => {
  const responses = [
    jsonResponse({ error: 'authorization_pending' }, 400),
    jsonResponse({
      access_token: 'microsoft-access',
      refresh_token: 'microsoft-refresh',
      expires_in: 3600
    })
  ];
  const waits: number[] = [];
  const token = await pollForMicrosoftToken({
    device_code: 'device-code',
    user_code: 'ABCD-EFGH',
    expires_in: 900,
    interval: 1
  }, {
    clientId: 'client-id',
    fetchImpl: async () => nextResponse(responses),
    sleep: async milliseconds => { waits.push(milliseconds); }
  });

  assert.equal(token.refresh_token, 'microsoft-refresh');
  assert.deepEqual(waits, [1000, 1000]);
});

test('a Microsoft token is exchanged for a Minecraft session and profile', async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const responses = [
    jsonResponse({ Token: 'xbox-user-token' }),
    jsonResponse({
      Token: 'xsts-token',
      DisplayClaims: { xui: [{ uhs: 'user-hash' }] }
    }),
    jsonResponse({ access_token: 'minecraft-token', expires_in: 86400 }),
    jsonResponse({ items: [{ name: 'game_minecraft' }] }),
    jsonResponse({ id: 'profile-id', name: 'Steve', skins: [], capes: [] })
  ];

  const session = await exchangeMicrosoftTokenForMinecraft({
    access_token: 'microsoft-token',
    refresh_token: 'refresh-token',
    expires_in: 3600
  }, {
    clientId: 'client-id',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return nextResponse(responses);
    }
  });

  assert.equal(requests.length, 5);
  assert.match(requests[0].url, /user\.auth\.xboxlive\.com/);
  assert.equal(JSON.parse(String(requests[0].options.body)).Properties.RpsTicket, 'd=microsoft-token');
  assert.equal(JSON.parse(String(requests[1].options.body)).RelyingParty, 'rp://api.minecraftservices.com/');
  assert.equal(
    JSON.parse(String(requests[2].options.body)).identityToken,
    'XBL3.0 x=user-hash;xsts-token'
  );
  assert.equal(new Headers(requests[3].options.headers).get('authorization'), 'Bearer minecraft-token');
  assert.equal(session.profile.name, 'Steve');
  assert.equal(session.microsoft.refreshToken, 'refresh-token');
  assert.equal(session.minecraft.accessToken, 'minecraft-token');
});

test('a missing Minecraft license stops sign-in before fetching the profile', async () => {
  const responses = [
    jsonResponse({ Token: 'xbox-user-token' }),
    jsonResponse({ Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } }),
    jsonResponse({ access_token: 'minecraft-token', expires_in: 86400 }),
    jsonResponse({ items: [] })
  ];

  await assert.rejects(
    exchangeMicrosoftTokenForMinecraft({
      access_token: 'microsoft-token',
      refresh_token: 'refresh-token'
    }, { fetchImpl: async () => nextResponse(responses) }),
    /does not have an active Minecraft: Java Edition license/
  );
});

test('a rejected App ID displays Minecraft Services review instructions', async () => {
  const responses = [
    jsonResponse({ Token: 'xbox-user-token' }),
    jsonResponse({ Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } }),
    jsonResponse({ errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo' }, 403)
  ];

  await assert.rejects(
    exchangeMicrosoftTokenForMinecraft({
      access_token: 'microsoft-token',
      refresh_token: 'refresh-token'
    }, { fetchImpl: async () => nextResponse(responses) }),
    /not yet been approved by Minecraft Services.*mce-reviewappid/
  );
});

test('session storage writes only an encrypted value', async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-auth-'));
  const session = sessionFixture();
  const protect = async (value: string) => Buffer.from(value, 'utf8').toString('base64');
  const unprotect = async (value: string) => Buffer.from(value, 'base64').toString('utf8');

  try {
    await saveSession(stateDirectory, session, { protect });
    const stored = await fs.readFile(getCredentialPath(stateDirectory), 'utf8');
    assert.doesNotMatch(stored, /refresh-token|Alex/);
    assert.deepEqual(await readSession(stateDirectory, { unprotect }), session);
    assert.equal(await clearSession(stateDirectory), true);
    assert.equal(await readSession(stateDirectory, { unprotect }), null);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('Windows DPAPI encrypts the session for the current user', {
  skip: process.platform !== 'win32'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-dpapi-'));
  const session = sessionFixture();
  try {
    await saveSession(stateDirectory, session);
    const stored = await fs.readFile(getCredentialPath(stateDirectory), 'utf8');
    assert.doesNotMatch(stored, /refresh-token|Alex/);
    assert.deepEqual(await readSession(stateDirectory), session);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('macOS session storage is restricted to the current user', {
  skip: process.platform !== 'darwin'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-macos-'));
  const session = sessionFixture();
  const createKeychainEntry = () => keychainFixture({
    deleteCredential() { throw new Error('login keychain unavailable'); }
  });
  try {
    await saveSession(stateDirectory, session, { storage: 'file', createKeychainEntry });
    const credentialPath = getCredentialPath(stateDirectory);
    const stored = await fs.readFile(credentialPath, 'utf8');
    assert.match(stored, /^macos-user-file:v1\n/);
    assert.equal((await fs.stat(credentialPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(credentialPath))).mode & 0o777, 0o700);
    assert.deepEqual(await readSession(stateDirectory), session);
    assert.equal(await clearSession(stateDirectory, { createKeychainEntry }), true);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('macOS stores the launcher session in the native Keychain by default', {
  skip: process.platform !== 'darwin'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-keychain-'));
  const session = sessionFixture();
  let stored: string | null = null;
  const createKeychainEntry = () => keychainFixture({
    setPassword(value: string) { stored = value; },
    getPassword() { return stored; },
    deleteCredential() {
      const existed = stored !== null;
      stored = null;
      return existed;
    }
  });
  try {
    await saveSession(stateDirectory, session, { createKeychainEntry });
    await assert.rejects(fs.access(getCredentialPath(stateDirectory)), { code: 'ENOENT' });
    assert.deepEqual(await readSession(stateDirectory, { createKeychainEntry }), session);
    assert.equal(await clearSession(stateDirectory, { createKeychainEntry }), true);
    assert.equal(stored, null);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('macOS Keychain failures recommend the explicit file fallback', {
  skip: process.platform !== 'darwin'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-keychain-'));
  const createKeychainEntry = () => keychainFixture({
    getPassword() { throw new Error('login keychain unavailable'); }
  });
  try {
    await assert.rejects(
      readSession(stateDirectory, { createKeychainEntry }),
      error => toError(error).code === 'MCPM_KEYCHAIN_UNAVAILABLE' &&
        /--storage=file/.test(toError(error).message)
    );
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('macOS reads and removes a session from the previous file location', {
  skip: process.platform !== 'darwin'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-legacy-'));
  const legacyPath = path.join(stateDirectory, 'features', 'launcher-account.dpapi');
  const session = sessionFixture();
  const createKeychainEntry = () => keychainFixture({
    deleteCredential() { throw new Error('login keychain unavailable'); }
  });
  try {
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, `macos-user-file:v1\n${JSON.stringify(session)}`, {
      mode: 0o600
    });
    assert.deepEqual(await readSession(stateDirectory), session);
    assert.equal(await clearSession(stateDirectory, { createKeychainEntry }), true);
    await assert.rejects(fs.access(legacyPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('macOS file storage remains usable without the native Keychain dependency', {
  skip: process.platform !== 'darwin'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-no-binding-'));
  const modulePath = path.join(stateDirectory, 'secure-storage.mjs');
  const session = sessionFixture();
  try {
    await fs.copyFile(new URL('../features/launcher/dist/secure-storage.js', import.meta.url), modulePath);
    await fs.copyFile(
      new URL('../features/launcher/dist/errors.js', import.meta.url),
      path.join(stateDirectory, 'errors.js')
    );
    await fs.writeFile(path.join(stateDirectory, 'package.json'), JSON.stringify({ type: 'module' }));
    const isolatedStorage: typeof import('../features/launcher/dist/secure-storage.js') =
      await import(pathToFileURL(modulePath).href);
    await assert.rejects(
      isolatedStorage.readSession(stateDirectory),
      error => toError(error).code === 'MCPM_KEYCHAIN_UNAVAILABLE' &&
        toError(toError(error).cause).code === 'ERR_MODULE_NOT_FOUND'
    );
    await isolatedStorage.saveSession(stateDirectory, session, { storage: 'file' });
    assert.deepEqual(await isolatedStorage.readSession(stateDirectory), session);
    assert.equal(await isolatedStorage.clearSession(stateDirectory), true);
    assert.equal(await isolatedStorage.readSession(stateDirectory), null);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('macOS file logout cannot resurrect an older session when Keychain cleanup fails', {
  skip: process.platform !== 'darwin'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-logout-'));
  const oldSession = sessionFixture({ profile: { name: 'Old' }, microsoft: { refreshToken: 'old-refresh-token' } });
  const session = sessionFixture();
  const brokenKeychain = () => keychainFixture({
    deleteCredential() { throw new Error('login keychain unavailable'); }
  });
  const unlockedKeychain = () => keychainFixture({
    getPassword() { return JSON.stringify(oldSession); }
  });
  try {
    await saveSession(stateDirectory, session, { storage: 'file', createKeychainEntry: brokenKeychain });
    assert.equal(await clearSession(stateDirectory, { createKeychainEntry: brokenKeychain }), true);
    assert.equal(await readSession(stateDirectory, { createKeychainEntry: unlockedKeychain }), null);
    assert.equal(await clearSession(stateDirectory, { createKeychainEntry: brokenKeychain }), false);
    await saveSession(stateDirectory, session, { createKeychainEntry: brokenKeychain });
    assert.deepEqual(await readSession(stateDirectory), session);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('macOS backend switching removes the old session and remembers the choice for refreshes', {
  skip: process.platform !== 'darwin'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-switch-'));
  const session = sessionFixture();
  const refreshed = sessionFixture({ microsoft: { refreshToken: 'new-refresh-token' } });
  let stored: string | null = null;
  const createKeychainEntry = () => keychainFixture({
    setPassword(value: string) { stored = value; },
    getPassword() { return stored; },
    deleteCredential() {
      const existed = stored !== null;
      stored = null;
      return existed;
    }
  });
  try {
    await saveSession(stateDirectory, session, { createKeychainEntry });
    await saveSession(stateDirectory, session, { storage: 'file', createKeychainEntry });
    assert.equal(stored, null);
    await saveSession(stateDirectory, refreshed, { createKeychainEntry });
    assert.equal(stored, null);
    assert.deepEqual(await readSession(stateDirectory), refreshed);

    await saveSession(stateDirectory, refreshed, { storage: 'keychain', createKeychainEntry });
    await assert.rejects(fs.access(getCredentialPath(stateDirectory)), { code: 'ENOENT' });
    assert.deepEqual(await readSession(stateDirectory, { createKeychainEntry }), refreshed);
    assert.equal(await clearSession(stateDirectory, { createKeychainEntry }), true);
    assert.equal(await readSession(stateDirectory, { createKeychainEntry }), null);
    await saveSession(stateDirectory, session, { createKeychainEntry });
    assert.deepEqual(JSON.parse(String(stored)), session);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('a failed macOS Keychain save preserves the previous file session and preference', {
  skip: process.platform !== 'darwin'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-save-failure-'));
  const session = sessionFixture();
  const createKeychainEntry = () => keychainFixture({
    deleteCredential() { return false; },
    setPassword() { throw new Error('login keychain unavailable'); }
  });
  try {
    await saveSession(stateDirectory, session, { storage: 'file', createKeychainEntry });
    await assert.rejects(
      saveSession(stateDirectory, sessionFixture({ microsoft: { refreshToken: 'new-token' } }), {
        storage: 'keychain', createKeychainEntry
      }),
      { code: 'MCPM_KEYCHAIN_UNAVAILABLE' }
    );
    assert.deepEqual(await readSession(stateDirectory), session);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('an unreadable macOS storage preference requires an explicit backend to recover', {
  skip: process.platform !== 'darwin'
}, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-preference-'));
  const session = sessionFixture();
  const createKeychainEntry = () => keychainFixture({ deleteCredential() { return false; } });
  try {
    await saveSession(stateDirectory, session, { storage: 'file', createKeychainEntry });
    await fs.writeFile(path.join(stateDirectory, 'credentials', 'launcher-storage.json'), '{broken');
    await assert.rejects(readSession(stateDirectory), {
      code: 'MCPM_STORAGE_PREFERENCE_UNREADABLE'
    });
    assert.deepEqual(await readSession(stateDirectory, { storage: 'file' }), session);
    await saveSession(stateDirectory, session, { storage: 'file', createKeychainEntry });
    assert.deepEqual(await readSession(stateDirectory), session);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});
