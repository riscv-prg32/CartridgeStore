import { requestSameOriginJson } from "./client";
import type { Game, GamesResponse } from "./contracts";
import { publicApiPath } from "./origin";
import { gameResponseSchema, gamesResponseSchema } from "./schemas";

export type CatalogQuery = {
  q?: string;
  page?: number;
  perPage?: number;
};

/**
 * Selects the physical ESP32 target when it is available.
 *
 * The API does not guarantee an ordering for the architecture list, so the
 * UI must not infer the default target from the first item.
 */
export function preferredCatalogArchitecture(
  architectures: readonly string[],
): string | undefined {
  return architectures.includes("esp32c6")
    ? "esp32c6"
    : architectures[0];
}

function catalogPath(path: string, query?: URLSearchParams): string {
  const suffix = query && query.toString() ? `?${query.toString()}` : "";
  return `/api/games${path}${suffix}`;
}

export function getCatalog(params: CatalogQuery = {}): Promise<GamesResponse> {
  const query = new URLSearchParams();
  if (params.q?.trim()) query.set("q", params.q.trim());
  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.perPage !== undefined) query.set("per_page", String(params.perPage));
  return requestSameOriginJson(catalogPath("", query), undefined, gamesResponseSchema);
}

export function getGame(gameId: string, version?: string): Promise<{ ok: true; game: Game }> {
  const query = version ? new URLSearchParams({ version }) : undefined;
  return requestSameOriginJson(catalogPath(`/${encodeURIComponent(gameId)}`, query), undefined, gameResponseSchema);
}

export function catalogMediaPath(
  gameId: string,
  kind: "icon" | "screenshot",
  version: string,
  architecture?: string,
): string {
  const query = new URLSearchParams({ version });
  if (architecture) query.set("architecture", architecture);
  return publicApiPath(catalogPath(`/${encodeURIComponent(gameId)}/${kind}`, query));
}

export function catalogDownloadPath(gameId: string, version: string, architecture: string): string {
  return publicApiPath(
    catalogPath(
      `/${encodeURIComponent(gameId)}/download`,
      new URLSearchParams({ version, architecture }),
    ),
  );
}
