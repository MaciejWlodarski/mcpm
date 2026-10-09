import type { AuthOptions, DeviceCode, MicrosoftToken, MinecraftProfile, MinecraftSession } from './types.js';
const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const XBOX_USER_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MINECRAFT_AUTH_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MINECRAFT_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore';
const MINECRAFT_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

export const DEFAULT_MICROSOFT_CLIENT_ID = '51b43610-2c23-4923-8378-e2a011ed16e4';
export const MICROSOFT_SCOPES = 'XboxLive.signin XboxLive.offline_access';

function getErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const body = payload as Record<string, unknown>;
  const detail = body.error_description || body.errorMessage || body.message;
  const description = typeof detail === 'string' ? detail : undefined;
  if (description?.includes('Invalid app registration')) {
    return 'The launcher App ID has not yet been approved by Minecraft Services. ' +
      'Submit the application for review: https://aka.ms/mce-reviewappid';
  }
  const code = body.XErr || body.error;
  if (description && code) return `${description} (${code})`;
  return description || (code ? String(code) : fallback);
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function postForm(url: string, values: Record<string, string>, fetchImpl: typeof fetch) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values)
  });
}

async function requestJson<T>(url: string, options: RequestInit, label: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, options);
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new Error(`${label}: ${getErrorMessage(payload, `HTTP ${response.status}`)}`);
  }
  return payload as T;
}

function bearerHeaders(accessToken: string) {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json'
  };
}

export async function requestDeviceCode(options: AuthOptions = {}): Promise<DeviceCode> {
  const clientId = options.clientId || DEFAULT_MICROSOFT_CLIENT_ID;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await postForm(`${MICROSOFT_AUTHORITY}/devicecode`, {
    client_id: clientId,
    scope: MICROSOFT_SCOPES
  }, fetchImpl);
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new Error(`Could not start Microsoft sign-in: ${getErrorMessage(payload, `HTTP ${response.status}`)}`);
  }
  return payload as DeviceCode;
}

export async function pollForMicrosoftToken(deviceCode: DeviceCode, options: AuthOptions = {}): Promise<MicrosoftToken> {
  const clientId = options.clientId || DEFAULT_MICROSOFT_CLIENT_ID;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now || Date.now;
  const expiresAt = now() + (Number(deviceCode.expires_in) || 900) * 1000;
  let interval = Math.max(Number(deviceCode.interval) || 5, 1) * 1000;

  while (now() < expiresAt) {
    await sleep(interval);
    const response = await postForm(`${MICROSOFT_AUTHORITY}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode.device_code
    }, fetchImpl);
    const responseBody = await readResponse(response);

    if (response.ok) return responseBody as MicrosoftToken;
    const payload = responseBody as Record<string, unknown>;
    if (payload.error === 'authorization_pending') continue;
    if (payload.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (payload.error === 'authorization_declined') {
      throw new Error('Microsoft sign-in was cancelled by the user.');
    }
    if (payload.error === 'expired_token') {
      throw new Error('The Microsoft sign-in code has expired. Start the sign-in process again.');
    }
    throw new Error(`Microsoft sign-in failed: ${getErrorMessage(payload, `HTTP ${response.status}`)}`);
  }

  throw new Error('The Microsoft sign-in code has expired. Start the sign-in process again.');
}

export async function refreshMicrosoftToken(refreshToken: string, options: AuthOptions = {}): Promise<MicrosoftToken> {
  const clientId = options.clientId || DEFAULT_MICROSOFT_CLIENT_ID;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await postForm(`${MICROSOFT_AUTHORITY}/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPES
  }, fetchImpl);
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new Error(`Could not refresh Microsoft sign-in: ${getErrorMessage(payload, `HTTP ${response.status}`)}`);
  }
  return payload as MicrosoftToken;
}

export async function exchangeMicrosoftTokenForMinecraft(microsoftToken: MicrosoftToken, options: AuthOptions = {}): Promise<MinecraftSession> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const xboxUser = await requestJson<{ Token: string }>(XBOX_USER_AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${microsoftToken.access_token}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    })
  }, 'Xbox Live sign-in failed', fetchImpl);

  const xsts = await requestJson<{ Token: string; DisplayClaims?: { xui?: { uhs: string }[] } }>(XSTS_AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xboxUser.Token]
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  }, 'Xbox Live authorization failed', fetchImpl);

  const userHash = xsts.DisplayClaims?.xui?.[0]?.uhs;
  if (!userHash || !xsts.Token) {
    throw new Error('The Xbox Live response does not contain an XSTS token or user identifier.');
  }

  const minecraft = await requestJson<{ access_token: string; username?: string; expires_in?: number }>(MINECRAFT_AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xsts.Token}` })
  }, 'Minecraft Services sign-in failed', fetchImpl);

  const entitlements = await requestJson<{ items: unknown[] }>(MINECRAFT_ENTITLEMENTS_URL, {
    headers: bearerHeaders(minecraft.access_token)
  }, 'Could not verify the Minecraft license', fetchImpl);
  if (!Array.isArray(entitlements.items) || entitlements.items.length === 0) {
    throw new Error('This Microsoft account does not have an active Minecraft: Java Edition license.');
  }

  const profile = await requestJson<MinecraftProfile>(MINECRAFT_PROFILE_URL, {
    headers: bearerHeaders(minecraft.access_token)
  }, 'Could not fetch the Minecraft profile', fetchImpl);

  const savedAt = Date.now();
  return {
    version: 1,
    clientId: options.clientId || DEFAULT_MICROSOFT_CLIENT_ID,
    savedAt: new Date(savedAt).toISOString(),
    microsoft: {
      refreshToken: microsoftToken.refresh_token,
      expiresAt: new Date(savedAt + (Number(microsoftToken.expires_in) || 3600) * 1000).toISOString()
    },
    minecraft: {
      accessToken: minecraft.access_token,
      xuid: minecraft.username || '',
      expiresAt: new Date(savedAt + (Number(minecraft.expires_in) || 86400) * 1000).toISOString()
    },
    profile: {
      id: profile.id,
      name: profile.name,
      skins: Array.isArray(profile.skins) ? profile.skins : [],
      capes: Array.isArray(profile.capes) ? profile.capes : []
    }
  };
}

export async function createMinecraftSession(options: AuthOptions = {}) {
  const clientId = options.clientId || DEFAULT_MICROSOFT_CLIENT_ID;
  const deviceCode = await requestDeviceCode({ ...options, clientId });
  if (options.onDeviceCode) await options.onDeviceCode(deviceCode);
  const microsoftToken = await pollForMicrosoftToken(deviceCode, { ...options, clientId });
  if (!microsoftToken.refresh_token) {
    throw new Error('Microsoft did not return a refresh token. Check the XboxLive.offline_access scope.');
  }
  return exchangeMicrosoftTokenForMinecraft(microsoftToken, { ...options, clientId });
}

export async function renewMinecraftSession(session: MinecraftSession, options: AuthOptions = {}) {
  if (!session?.microsoft?.refreshToken) {
    throw new Error('The saved session does not contain a refresh token. Sign in again.');
  }
  const clientId = options.clientId || session.clientId || DEFAULT_MICROSOFT_CLIENT_ID;
  const microsoftToken = await refreshMicrosoftToken(session.microsoft.refreshToken, {
    ...options,
    clientId
  });
  if (!microsoftToken.refresh_token) microsoftToken.refresh_token = session.microsoft.refreshToken;
  return exchangeMicrosoftTokenForMinecraft(microsoftToken, { ...options, clientId });
}
