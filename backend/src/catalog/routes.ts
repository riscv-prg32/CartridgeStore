import fs from "node:fs";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { parseCookies } from "../auth/session.js";
import type { AuthService } from "../auth/service.js";
import type { BackendConfig } from "../config/env.js";
import { encodePythonJson } from "../compatibility/serialization.js";
import type { ReadonlyDatabaseManager } from "../db/readonly.js";
import {
  CARTRIDGE_MIME,
  CatalogError,
  DISCOVERY_ABI,
  ReadonlyCatalog,
  ROLE_LEVELS,
  fileEtag,
  parseCartridgeMedia,
  paginateCatalog,
  type ResolvedVariant
} from "./catalog.js";
import { CanonicalCatalog, type ResolvedCatalogMedia } from "../storage-v2/catalog.js";
import { CANONICAL_DISPOSABLE_READ_MODE, CANONICAL_OPERATIONAL_READ_MODE, CANONICAL_READ_AUTHORIZATION } from "../storage-v2/read-mode.js";
import { API_V1_BASE_PATH, API_V1_VERSION } from "../api/versioning.js";

interface CatalogQuery {
  readonly q?: string;
  readonly search?: string;
  readonly page?: string;
  readonly per_page?: string;
  readonly limit?: string;
  readonly version?: string;
  readonly architecture?: string;
}

interface GameParams {
  readonly game_id: string;
}

interface CatalogRouteOptions {
  readonly config: BackendConfig;
  readonly database: ReadonlyDatabaseManager;
  readonly auth?: AuthService;
  readonly downloadTelemetry?: DownloadTelemetrySink;
}

export interface DownloadTelemetrySink {
  recordDownload(event: {
    readonly gameId: string;
    readonly version: string;
    readonly architecture: "esp32c6" | "qemu";
    readonly userId: number | null;
    readonly ipAddress: string | null;
    readonly userAgent: string;
  }): void;
}

interface CatalogReadSource {
  readonly listGames: (query?: string) => Record<string, unknown>[];
  readonly publicGame: (gameId: string, version?: string) => Record<string, unknown>;
  readonly resolveVariant: (gameId: string, version?: string, architecture?: string) => ResolvedVariant;
  readonly resolveMedia: (gameId: string, version: string | undefined, architecture: string | undefined, kind: "icon" | "screenshot") => ResolvedCatalogMedia | { readonly bytes: Buffer; readonly mediaType: string };
  readonly colophon: (gameId: string, version?: string) => Record<string, unknown>;
  readonly storeName: (fallback: string) => string;
  readonly close: () => void;
}

class LegacyCatalogReadSource implements CatalogReadSource {
  constructor(private readonly catalog: ReadonlyCatalog, private readonly readStoreName: () => string) {}

  listGames(query?: string): Record<string, unknown>[] { return this.catalog.listGames(query); }
  publicGame(gameId: string, version?: string): Record<string, unknown> { return this.catalog.publicGame(gameId, version); }
  resolveVariant(gameId: string, version?: string, architecture?: string): ResolvedVariant { return this.catalog.resolveVariant(gameId, version, architecture); }
  resolveMedia(gameId: string, version: string | undefined, architecture: string | undefined, kind: "icon" | "screenshot"): { readonly bytes: Buffer; readonly mediaType: string } {
    const resolved = this.catalog.resolveVariant(gameId, version, architecture);
    const media = parseCartridgeMedia(fs.readFileSync(resolved.filePath));
    if (kind === "icon" && media.icon) return { bytes: media.icon, mediaType: stringHeader(resolved.variant.icon_mime, media.iconMime ?? "image/png") };
    if (kind === "screenshot" && media.screenshot) return { bytes: media.screenshot, mediaType: stringHeader(resolved.variant.screenshot_mime, media.screenshotMime ?? "image/png") };
    throw new CatalogError(`${kind} not found`);
  }
  colophon(gameId: string, version?: string): Record<string, unknown> {
    const resolved = this.catalog.resolveVariant(gameId, version);
    const media = parseCartridgeMedia(fs.readFileSync(resolved.filePath));
    if (!media.colophon) throw new CatalogError("colophon not found");
    return media.colophon;
  }
  storeName(fallback: string): string {
    try {
      return this.readStoreName() || fallback;
    } catch {
      return fallback;
    }
  }
  close(): void { /* legacy catalog has no open resource */ }
}

class CanonicalCatalogReadSource implements CatalogReadSource {
  constructor(private readonly catalog: CanonicalCatalog) {}
  listGames(query?: string): Record<string, unknown>[] { return this.catalog.listGames(query); }
  publicGame(gameId: string, version?: string): Record<string, unknown> { return this.catalog.publicGame(gameId, version); }
  resolveVariant(gameId: string, version?: string, architecture?: string): ResolvedVariant { return this.catalog.resolveVariant(gameId, version, architecture); }
  resolveMedia(gameId: string, version: string | undefined, architecture: string | undefined, kind: "icon" | "screenshot"): ResolvedCatalogMedia { return this.catalog.resolveMedia(gameId, version, architecture, kind); }
  colophon(gameId: string, version?: string): Record<string, unknown> { return this.catalog.colophon(gameId, version); }
  storeName(fallback: string): string { return this.catalog.storeName(fallback); }
  close(): void { this.catalog.close(); }
}

function createCatalogReadSource(options: CatalogRouteOptions): CatalogReadSource {
  if (options.config.catalogReadMode === CANONICAL_DISPOSABLE_READ_MODE || options.config.catalogReadMode === CANONICAL_OPERATIONAL_READ_MODE) {
    if (!options.config.canonicalStorageRoot || (options.config.catalogReadMode === CANONICAL_DISPOSABLE_READ_MODE && options.config.canonicalReadAuthorization !== CANONICAL_READ_AUTHORIZATION) || (options.config.catalogReadMode === CANONICAL_OPERATIONAL_READ_MODE && (!options.config.canonicalReadAuthorization || options.config.canonicalReadAuthorization.length < 32))) throw new Error("canonical catalog mode is not authorized");
    return new CanonicalCatalogReadSource(new CanonicalCatalog(options.config.canonicalStorageRoot, {
      operational: options.config.catalogReadMode === CANONICAL_OPERATIONAL_READ_MODE,
      legacyRoots: options.config.candidateRuntimeMode === undefined &&
        options.config.canonicalWorkflowMode === undefined &&
        options.config.catalogReadMode !== CANONICAL_OPERATIONAL_READ_MODE
        ? [options.config.storeDataDirectory, options.config.databasePath]
        : []
    }));
  }
  return new LegacyCatalogReadSource(new ReadonlyCatalog(options.config.storeDataDirectory), () => legacyStoreName(options));
}

function sendJson(reply: FastifyReply, body: unknown): FastifyReply {
  return reply.header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

function legacyStoreName(options: CatalogRouteOptions): string {
  try {
    const row = options.database.get().sqlite
      .prepare("SELECT value FROM store_settings WHERE key = 'store_name'")
      .get() as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? row.value : options.config.storeName;
  } catch {
    return options.config.storeName;
  }
}

function requestHost(request: FastifyRequest, config: BackendConfig): string {
  if (config.frontendPublicOrigin) {
    return new URL(config.frontendPublicOrigin).host;
  }
  const configuredHost = typeof request.headers.host === "string"
    ? request.headers.host
    : `${request.hostname}:${config.port}`;
  if (!config.storePortOverride) return configuredHost;
  return `${configuredHost.split(":", 1)[0]}:${config.storePortOverride}`;
}

function queryObject(query: CatalogQuery): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined));
}

function setFileHeaders(reply: FastifyReply, filePath: string, stat: fs.Stats): string {
  const etag = fileEtag(filePath, stat);
  reply
    .header("content-length", stat.size)
    .header("cache-control", "no-cache")
    .header("last-modified", new Date(stat.mtimeMs).toUTCString())
    .header("etag", etag)
    .header("accept-ranges", "bytes");
  return etag;
}

function conditionalNotModified(request: FastifyRequest, etag: string, stat: fs.Stats): boolean {
  const ifNoneMatch = request.headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && ifNoneMatch.split(",").map((value) => value.trim()).includes(etag)) {
    return true;
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (typeof ifModifiedSince === "string") {
    const timestamp = Date.parse(ifModifiedSince);
    if (Number.isFinite(timestamp) && Math.floor(stat.mtimeMs / 1000) * 1000 <= timestamp) return true;
  }
  return false;
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (match[1] === "" && match[2] === "")) throw new CatalogError("invalid range");
  const startText = match[1];
  const endText = match[2];
  let start: number;
  let end: number;
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new CatalogError("invalid range");
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? size - 1 : Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      throw new CatalogError("invalid range");
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function sendDownload(
  request: FastifyRequest<{ Querystring: CatalogQuery }>,
  reply: FastifyReply,
  filePath: string,
  gameId: string,
  version: string,
  architecture: string,
  telemetry: { readonly auth?: AuthService; readonly sink?: DownloadTelemetrySink }
): FastifyReply {
  const stat = fs.statSync(filePath);
  const etag = setFileHeaders(reply, filePath, stat);
  reply
    .header("content-type", CARTRIDGE_MIME)
    .header("content-disposition", `attachment; filename=${gameId}-${version}-${architecture}.prg32`);
  const range = parseRange(request.headers.range, stat.size);
  if (telemetry.sink) {
    const bearer = request.headers.authorization;
    const token = typeof bearer === "string" && bearer.toLowerCase().startsWith("bearer ")
      ? bearer.slice(7).trim() || undefined
      : typeof request.headers["x-prg32-token"] === "string" ? request.headers["x-prg32-token"].trim() || undefined : undefined;
    const authContext = telemetry.auth?.context(parseCookies(request.headers.cookie).get("prg32_ts_session"), token);
    telemetry.sink.recordDownload({
      gameId,
      version,
      architecture: architecture as "esp32c6" | "qemu",
      userId: authContext?.principal.authenticated ? authContext.principal.id : null,
      ipAddress: request.ip || null,
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : ""
    });
  }
  if (conditionalNotModified(request, etag, stat)) return reply.code(304).send();

  if (!range) return reply.send(fs.createReadStream(filePath));
  const length = range.end - range.start + 1;
  reply
    .code(206)
    .header("content-length", length)
    .header("content-range", `bytes ${range.start}-${range.end}/${stat.size}`);
  return reply.send(fs.createReadStream(filePath, { start: range.start, end: range.end }));
}

export function registerCatalogRoutes(app: FastifyInstance, options: CatalogRouteOptions): CatalogReadSource {
  const catalog = createCatalogReadSource(options);

  app.get("/.well-known/prg32-store.json", async (request, reply) => {
    const webOrigin = options.config.frontendPublicOrigin
      ? new URL(options.config.frontendPublicOrigin).origin
      : undefined;
    const apiOrigin = options.config.federationPublicOrigin
      ? new URL(options.config.federationPublicOrigin).origin
      : webOrigin;
    const webHost = webOrigin ? new URL(webOrigin).host : requestHost(request, options.config);
    const webScheme = webOrigin ? new URL(webOrigin).protocol.replace(":", "") : request.protocol;
    const apiBase = apiOrigin ?? `${webScheme}://${webHost}`;
    const apiHost = apiOrigin ? new URL(apiOrigin).host : webHost;
    const apiScheme = apiOrigin ? new URL(apiOrigin).protocol.replace(":", "") : webScheme;
    const websocket = apiScheme === "https" ? "wss" : "ws";
    const legacyApiBase = `${apiBase}/api`;
    const versionedApiBase = `${apiBase}${API_V1_BASE_PATH}`;
    const versionedServices = {
      cartridges: `${versionedApiBase}/games`,
      bundle_publish: `${versionedApiBase}/publish/bundle`,
      submissions: `${versionedApiBase}/submissions`,
      scores: `${versionedApiBase}/scores`,
      metrics: `${versionedApiBase}/runs`,
      multiplayer: `${websocket}://${apiHost}${API_V1_BASE_PATH}/multiplayer`,
      multiplayer_status: `${versionedApiBase}/multiplayer/status`
    };
    return sendJson(reply, {
      abi: DISCOVERY_ABI,
      name: catalog.storeName(options.config.storeName),
      // `api` and `services` are retained for existing firmware. New clients
      // must use api_base/api_versions and services_v1 below.
      api: legacyApiBase,
      api_version: API_V1_VERSION,
      api_base: versionedApiBase,
      api_versions: [{ version: API_V1_VERSION, status: "stable", base_url: versionedApiBase }],
      web: `${webOrigin ?? `${webScheme}://${webHost}`}/`,
      version: options.config.storeVersion,
      auth_enabled: true,
      roles: [...ROLE_LEVELS],
      services: {
        cartridges: `${apiBase}/api/games`,
        bundle_publish: `${apiBase}/api/publish/bundle`,
        submissions: `${apiBase}/api/submissions`,
        scores: `${apiBase}/api/scores`,
        metrics: `${apiBase}/api/runs`,
        multiplayer: `${websocket}://${apiHost}/api/multiplayer`,
        multiplayer_status: `${apiBase}/api/multiplayer/status`
      },
      services_v1: versionedServices
    });
  });

  const apiIndex = (_request: FastifyRequest, reply: FastifyReply) => sendJson(reply, {
    ok: true,
    service: catalog.storeName(options.config.storeName),
    version: options.config.storeVersion,
    api_version: API_V1_VERSION,
    api_base: API_V1_BASE_PATH,
    auth_enabled: true,
    roles: [...ROLE_LEVELS],
    mdns: {
      service: "_prg32store._tcp.local.",
      name: options.config.mdnsName
    },
    endpoints: [
      "GET /api/games",
      "POST /api/publish",
      "POST /api/publish/bundle",
      "GET /api/submissions",
      "GET /api/scores",
      "POST /api/scores",
      "GET /api/metrics",
      "GET /api/runs",
      "POST /api/runs",
      "POST /api/metrics/batch",
      "GET /api/multiplayer",
      "GET /api/multiplayer/status"
    ],
    versioned_endpoints: [
      "GET /api/v1/games",
      "POST /api/v1/publish",
      "POST /api/v1/publish/bundle",
      "GET /api/v1/submissions",
      "GET /api/v1/scores",
      "POST /api/v1/scores",
      "GET /api/v1/metrics",
      "GET /api/v1/runs",
      "POST /api/v1/runs",
      "POST /api/v1/metrics/batch",
      "GET /api/v1/multiplayer",
      "GET /api/v1/multiplayer/status"
    ]
  });

  app.get("/api", apiIndex);
  app.get("/api/", apiIndex);

  app.get<{ Querystring: CatalogQuery }>("/api/games", async (request, reply) => {
    const query = request.query;
    const games = catalog.listGames(query.q || query.search);
    const pagination = paginateCatalog(games, queryObject(query));
    const { items, ...paginationFields } = pagination;
    return sendJson(reply, { ok: true, games: items, pagination: paginationFields });
  });

  app.get<{ Params: GameParams; Querystring: CatalogQuery }>("/api/games/:game_id", async (request, reply) => {
    return sendJson(reply, { ok: true, game: catalog.publicGame(request.params.game_id, request.query.version) });
  });

  app.get<{ Params: GameParams; Querystring: CatalogQuery }>("/api/games/:game_id/icon", async (request, reply) => {
    const media = catalog.resolveMedia(request.params.game_id, request.query.version, request.query.architecture, "icon");
    if ("bytes" in media) return reply.header("content-type", media.mediaType).header("content-length", media.bytes.length).send(media.bytes);
    const stat = fs.statSync(media.filePath);
    return reply.header("content-type", media.mediaType).header("content-length", stat.size).send(fs.createReadStream(media.filePath));
  });

  app.get<{ Params: GameParams; Querystring: CatalogQuery }>("/api/games/:game_id/screenshot", async (request, reply) => {
    const media = catalog.resolveMedia(request.params.game_id, request.query.version, request.query.architecture, "screenshot");
    if ("bytes" in media) return reply.header("content-type", media.mediaType).header("content-length", media.bytes.length).send(media.bytes);
    const stat = fs.statSync(media.filePath);
    return reply.header("content-type", media.mediaType).header("content-length", stat.size).send(fs.createReadStream(media.filePath));
  });

  app.get<{ Params: GameParams; Querystring: CatalogQuery }>("/api/games/:game_id/colophon", async (request, reply) => {
    return sendJson(reply, { ok: true, colophon: catalog.colophon(request.params.game_id, request.query.version) });
  });

  app.get<{ Params: GameParams; Querystring: CatalogQuery }>("/api/games/:game_id/download", async (request, reply) => {
    const resolved = catalog.resolveVariant(request.params.game_id, request.query.version, request.query.architecture);
    return sendDownload(request, reply, resolved.filePath, stringHeader(resolved.publicGame.id, request.params.game_id), resolved.version, resolved.architecture, {
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.downloadTelemetry === undefined ? {} : { sink: options.downloadTelemetry })
    });
  });

  return catalog;
}

function stringHeader(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}
