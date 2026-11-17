/**
 * Versioned public API routing.
 *
 * The first public API generation is exposed canonically at `/api/v1`. The
 * unversioned `/api` routes remain registered for existing firmware and tools;
 * rewriting happens before Fastify route matching so both paths execute the
 * same handlers and validation.
 */
export const API_V1_VERSION = "v1" as const;
export const API_V1_BASE_PATH = "/api/v1" as const;
export const API_LEGACY_BASE_PATH = "/api" as const;

export function rewriteVersionedApiUrl(url: string | undefined): string {
  if (url === undefined) return "/";
  const queryIndex = url.indexOf("?");
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : url.slice(queryIndex);

  if (path === API_V1_BASE_PATH) return `${API_LEGACY_BASE_PATH}${query}`;
  if (path.startsWith(`${API_V1_BASE_PATH}/`)) {
    return `${API_LEGACY_BASE_PATH}${path.slice(API_V1_BASE_PATH.length)}${query}`;
  }
  return url;
}
