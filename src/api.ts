import type { GameVersion, ModrinthProject, ModrinthVersion, SearchHit } from './types.js';
const BASE_URL = 'https://api.modrinth.com/v2';
const USER_AGENT = 'zireael/mcpm/1.0.0 (contact@zirea.el)';
const MAX_RETRIES = 3;

function sleep(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function parseErrorBody(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function retryDelay(response: Response, body: Record<string, unknown>, attempt: number) {
  const retryAfter = response.headers.get('retry-after') || body.retry_after;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return Math.min(30000, 1000 * 2 ** attempt);
}

function apiErrorMessage(status: number, body: Record<string, unknown>, statusText: string) {
  if (status === 429) {
    const retryAfter = Number(body.retry_after);
    const suffix = Number.isFinite(retryAfter) && retryAfter > 0
      ? ` Retry after ${retryAfter}s.`
      : '';
    return `Modrinth API rate limit exceeded.${suffix}`;
  }

  const detail = body.detail || body.description || body.message || statusText;
  return `Modrinth API error (${status}): ${detail}`;
}

async function apiRequest<T>(endpoint: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, String(value));
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      }
    });

    if (response.ok) return response.json() as Promise<T>;

    if (response.status === 404) {
      throw new Error(`Resource not found at ${endpoint}`);
    }

    const body = parseErrorBody(await response.text());
    const isRetryable = response.status === 429 || body.retryable === true;
    if (isRetryable && attempt < MAX_RETRIES) {
      await sleep(retryDelay(response, body, attempt));
      continue;
    }

    throw new Error(apiErrorMessage(response.status, body, response.statusText));
  }
  throw new Error('Modrinth API request exhausted its retries');
}

/**
 * Searches for mods on Modrinth.
 * @param {string} query The search query.
 * @param {number} limit Maximum results to return.
 */
export async function searchMods(query: string, limit = 10): Promise<SearchHit[]> {
  const params = {
    query,
    limit,
    facets: JSON.stringify([['project_type:mod']])
  };
  const result = await apiRequest<{ hits: SearchHit[] }>('/search', params);
  return result.hits;
}

/**
 * Gets details of a specific project (mod).
 * @param {string} slugOrId The slug or unique ID of the mod.
 */
export async function getProject(slugOrId: string): Promise<ModrinthProject> {
  // If slugOrId is empty or undefined, throw early
  if (!slugOrId) {
    throw new Error('Project identifier is required');
  }
  return apiRequest(`/project/${encodeURIComponent(slugOrId)}`);
}

/**
 * Gets details for multiple projects.
 * @param {string[]} idsOrSlugs The project IDs or slugs.
 */
export async function getProjects(idsOrSlugs: string[]): Promise<ModrinthProject[]> {
  const ids = [...new Set(idsOrSlugs)].filter(Boolean);
  if (ids.length === 0) return [];
  return apiRequest('/projects', { ids: JSON.stringify(ids) });
}

/**
 * Gets compatible versions of a project.
 * @param {string} projectId The project ID or slug.
 * @param {string} mcVersion The Minecraft version (e.g. "1.20.1").
 * @param {string} loader The mod loader (e.g. "fabric").
 */
export async function getProjectVersions(projectId: string, mcVersion?: string, loader?: string): Promise<ModrinthVersion[]> {
  const params: Record<string, string> = {
    include_changelog: 'false'
  };
  
  if (mcVersion) {
    params.game_versions = JSON.stringify([mcVersion]);
  }
  if (loader) {
    params.loaders = JSON.stringify([loader]);
  }

  return apiRequest(`/project/${encodeURIComponent(projectId)}/version`, params);
}

/**
 * Gets details of a specific version.
 * @param {string} versionId The version ID.
 */
export async function getVersion(versionId: string): Promise<ModrinthVersion> {
  return apiRequest(`/version/${encodeURIComponent(versionId)}`);
}

/**
 * Gets details for multiple versions.
 * @param {string[]} versionIds The version IDs.
 */
export async function getVersions(versionIds: string[]): Promise<ModrinthVersion[]> {
  const ids = [...new Set(versionIds)].filter(Boolean);
  if (ids.length === 0) return [];
  return apiRequest('/versions', { ids: JSON.stringify(ids) });
}

/**
 * Gets the list of all Minecraft game versions.
 */
export async function getGameVersions(): Promise<GameVersion[]> {
  return apiRequest('/tag/game_version');
}
