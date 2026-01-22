/**
 * URL normalization utilities for API base URLs
 *
 * Handles the complexity of user-provided base URLs that may or may not include
 * path segments. Supports both "full path" format (legacy) and "host root" format (new).
 *
 * Examples:
 *   - Old format: "http://proxy:3000/v1beta/models" → works as-is
 *   - New format: "http://proxy:3000/" → appends required path
 *   - Edge cases: double slashes, trailing slashes, mixed paths
 */

/**
 * Known API path suffixes that should be stripped before appending new paths.
 * Order matters: longer/more specific paths first.
 */
const KNOWN_PATH_SUFFIXES = [
  '/v1beta/models',
  '/v1/models',
  '/v1beta',
  '/v1',
];

/**
 * Normalize a base URL and optionally append a path suffix.
 *
 * This function handles the complexity of users providing base URLs in different formats:
 * 1. Full path: "http://proxy:3000/v1beta/models" - use as-is (legacy support)
 * 2. Host root: "http://proxy:3000/" - append the required path
 * 3. Mixed: "http://proxy:3000/v1beta" with suffix "v1beta/models" - detect and handle
 *
 * Algorithm:
 * 1. Strip query string and hash (users may paste URLs with ?key=...)
 * 2. Canonicalize the URL (trim, remove trailing slashes, collapse internal double slashes)
 * 3. Strip any known path suffixes to get the true base
 * 4. Append the requested path suffix
 *
 * @param url - The base URL provided by the user
 * @param pathSuffix - Optional path to append (e.g., 'v1beta/models')
 * @returns Normalized URL ready for further path appending
 */
export function normalizeBaseUrl(url: string, pathSuffix?: string): string {
  if (!url) {
    return '';
  }

  // Step 0: Strip query string and hash (users may paste full URLs with ?key=...)
  let normalized = url.trim();
  const queryIndex = normalized.indexOf('?');
  const hashIndex = normalized.indexOf('#');
  const cutIndex = Math.min(
    queryIndex >= 0 ? queryIndex : Infinity,
    hashIndex >= 0 ? hashIndex : Infinity
  );
  if (cutIndex < Infinity) {
    normalized = normalized.slice(0, cutIndex);
  }

  // Step 1: Canonicalize
  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, '');

  // Collapse internal double slashes (but preserve protocol's //)
  // Split on ://, process the rest, rejoin
  const protocolMatch = normalized.match(/^([a-z][a-z0-9+.-]*:\/\/)/i);
  if (protocolMatch) {
    const protocol = protocolMatch[1];
    const rest = normalized.slice(protocol.length);
    // Collapse multiple slashes to single slash
    const cleanedRest = rest.replace(/\/+/g, '/');
    normalized = protocol + cleanedRest;
  }

  // Step 2: Strip known path suffixes to get true base
  // This prevents issues like /v1beta/models/v1/models
  for (const suffix of KNOWN_PATH_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break; // Only strip one suffix
    }
  }

  // Remove any trailing slashes after stripping
  normalized = normalized.replace(/\/+$/, '');

  // Step 3: Append path suffix if provided
  if (pathSuffix) {
    // Ensure suffix starts with /
    const cleanSuffix = pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`;
    normalized = `${normalized}${cleanSuffix}`;
  }

  return normalized;
}

/**
 * Build a Gemini API URL for a specific model and action.
 *
 * @param baseUrl - The user-configured base URL (may be full path or host root)
 * @param model - The model name (e.g., 'gemini-2.5-flash')
 * @param action - The API action (e.g., 'generateContent')
 * @param apiKey - The API key to append as query param (will be URL-encoded)
 * @returns Complete API URL ready for fetch
 */
export function buildGeminiApiUrl(
  baseUrl: string,
  model: string,
  action: string,
  apiKey: string
): string {
  const normalizedBase = normalizeBaseUrl(baseUrl, 'v1beta/models');
  // Use encodeURIComponent for API key to handle special characters safely
  return `${normalizedBase}/${model}:${action}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Build an OpenAI-compatible API URL.
 * For OpenAI-style APIs, the base URL should include the version (e.g., /v1),
 * and we append /models, /chat/completions, etc.
 *
 * @param baseUrl - The user-configured base URL (e.g., 'https://api.openai.com/v1')
 * @param endpoint - The endpoint path (e.g., 'models', 'chat/completions')
 * @returns Complete API URL ready for fetch
 */
export function buildOpenAIApiUrl(baseUrl: string, endpoint: string): string {
  // For OpenAI-style APIs, normalize but don't strip /v1 since it's part of the API
  // Only strip /v1/models etc. if present
  let normalized = baseUrl.trim().replace(/\/+$/, '');

  // Strip trailing /models, /chat/completions etc. but keep /v1
  const openaiEndpoints = ['/models', '/chat/completions', '/completions', '/embeddings'];
  for (const ep of openaiEndpoints) {
    if (normalized.endsWith(ep)) {
      normalized = normalized.slice(0, -ep.length);
      break;
    }
  }

  // Ensure endpoint starts with /
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${normalized}${cleanEndpoint}`;
}
