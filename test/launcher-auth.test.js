import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  exchangeMicrosoftTokenForMinecraft,
  MICROSOFT_SCOPES,
  pollForMicrosoftToken,
  requestDeviceCode
} from '../features/launcher/src/auth.js';
import {
  clearSession,
  getCredentialPath,
  readSession,
  saveSession
} from '../features/launcher/src/secure-storage.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('device code flow uses personal accounts and Xbox Live scopes', async () => {
  let request;
  const deviceCode = await requestDeviceCode({
    clientId: 'client-id',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        device_code: 'device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://microsoft.com/link',
        expires_in: 900,
        interval: 5
      });
    }
  });

  assert.match(request.url, /\/consumers\/oauth2\/v2\.0\/devicecode$/);
  assert.equal(request.options.body.get('client_id'), 'client-id');
  assert.equal(request.options.body.get('scope'), MICROSOFT_SCOPES);
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
  const waits = [];
  const token = await pollForMicrosoftToken({
    device_code: 'device-code',
    expires_in: 900,
    interval: 1
  }, {
    clientId: 'client-id',
    fetchImpl: async () => responses.shift(),
    sleep: async milliseconds => { waits.push(milliseconds); }
  });

  assert.equal(token.refresh_token, 'microsoft-refresh');
  assert.deepEqual(waits, [1000, 1000]);
});

test('a Microsoft token is exchanged for a Minecraft session and profile', async () => {
  const requests = [];
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
      requests.push({ url, options });
      return responses.shift();
    }
  });

  assert.equal(requests.length, 5);
  assert.match(requests[0].url, /user\.auth\.xboxlive\.com/);
  assert.equal(JSON.parse(requests[0].options.body).Properties.RpsTicket, 'd=microsoft-token');
  assert.equal(JSON.parse(requests[1].options.body).RelyingParty, 'rp://api.minecraftservices.com/');
  assert.equal(
    JSON.parse(requests[2].options.body).identityToken,
    'XBL3.0 x=user-hash;xsts-token'
  );
  assert.equal(requests[3].options.headers.authorization, 'Bearer minecraft-token');
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
    }, { fetchImpl: async () => responses.shift() }),
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
    }, { fetchImpl: async () => responses.shift() }),
    /not yet been approved by Minecraft Services.*mce-reviewappid/
  );
});

test('session storage writes only an encrypted value', async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpm-launcher-auth-'));
  const session = { profile: { name: 'Alex' }, secret: 'refresh-token' };
  const protect = async value => Buffer.from(value, 'utf8').toString('base64');
  const unprotect = async value => Buffer.from(value, 'base64').toString('utf8');

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
  const session = { profile: { name: 'Alex' }, secret: 'refresh-token' };
  try {
    await saveSession(stateDirectory, session);
    const stored = await fs.readFile(getCredentialPath(stateDirectory), 'utf8');
    assert.doesNotMatch(stored, /refresh-token|Alex/);
    assert.deepEqual(await readSession(stateDirectory), session);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});
