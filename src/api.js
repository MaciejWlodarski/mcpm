const BASE_URL = 'https://api.modrinth.com/v2';
const USER_AGENT = 'zireael/mcpm/1.0.0 (contact@zirea.el)';

async function apiRequest(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });

  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Resource not found at ${endpoint}`);
    }
    const text = await response.text();
    throw new Error(`Modrinth API error (${response.status}): ${text || response.statusText}`);
  }

  return response.json();
}

/**
 * Searches for mods on Modrinth.
 * @param {string} query The search query.
 * @param {number} limit Maximum results to return.
 */
export async function searchMods(query, limit = 10) {
  const params = {
    query,
    limit,
    facets: JSON.stringify([['project_type:mod']])
  };
  const result = await apiRequest('/search', params);
  return result.hits;
}

/**
 * Gets details of a specific project (mod).
 * @param {string} slugOrId The slug or unique ID of the mod.
 */
export async function getProject(slugOrId) {
  // If slugOrId is empty or undefined, throw early
  if (!slugOrId) {
    throw new Error('Project identifier is required');
  }
  return apiRequest(`/project/${encodeURIComponent(slugOrId)}`);
}

/**
 * Gets compatible versions of a project.
 * @param {string} projectId The project ID or slug.
 * @param {string} mcVersion The Minecraft version (e.g. "1.20.1").
 * @param {string} loader The mod loader (e.g. "fabric").
 */
export async function getProjectVersions(projectId, mcVersion, loader) {
  const params = {
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
export async function getVersion(versionId) {
  return apiRequest(`/version/${encodeURIComponent(versionId)}`);
}

/**
 * Gets the list of all Minecraft game versions.
 */
export async function getGameVersions() {
  return apiRequest('/tag/game_version');
}

