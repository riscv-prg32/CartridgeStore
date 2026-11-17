import type { BackendConfig } from "../config/env.js";
import type Database from "better-sqlite3";
import { CatalogError, fileSha256, normalizeArchitecture, ReadonlyCatalog, safeGameId, safeVersion } from "../catalog/catalog.js";
import type { ResolvedVariant } from "../catalog/catalog.js";
import { REVIEW_EDITABLE_METADATA_FIELDS } from "../consistency/publication.js";
import type { PublicationConsistencyService } from "../consistency/publication.js";
import { PublicationConsistencyError } from "../consistency/errors.js";
import { AdminAuditLog } from "./audit.js";
import { AdminError, type AdminMutationContext } from "./service.js";

const MAX_QUERY_LENGTH = 80;
const MAX_TAGS = 64;
const MAX_TAG_LENGTH = 80;
const MAX_TEXT_LENGTH = 4096;

export interface CatalogListOptions {
  readonly page: number;
  readonly limit: number;
  readonly query?: string;
  readonly version?: string;
  readonly architecture?: string;
  readonly moderationAction?: "visible" | "hidden" | "unpublished";
}

export interface CatalogMutationOptions {
  readonly gameId: string;
  readonly version: string;
  readonly metadata?: Record<string, unknown>;
  readonly architecture?: string;
}

export interface AdminCartridgeVariant {
  readonly architecture: string;
  readonly size: number;
  readonly sha256: string;
  readonly icon_mime: string | null;
  readonly screenshot_mime: string | null;
  readonly has_screenshot: boolean;
  readonly has_signature: boolean;
  readonly updated_at: unknown;
}

export interface AdminCartridgeView {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly authors: readonly unknown[];
  readonly tags: readonly unknown[];
  readonly latest_version: unknown;
  readonly selected_version: string;
  readonly versions: readonly string[];
  readonly architectures: readonly string[];
  readonly metadata: Record<string, unknown> | null;
  readonly colophon: Record<string, unknown> | null;
  readonly variants: Readonly<Record<string, AdminCartridgeVariant>>;
  readonly publisher: string;
  readonly updated_at: unknown;
  readonly publication_state: "published";
  readonly artifact_state: "available" | "inconsistent" | "unavailable";
  readonly moderation_action?: "visible" | "hidden" | "unpublished";
  readonly moderation_reason?: string;
  readonly moderation_updated_at?: unknown;
}

interface AdminCatalogRead {
  listGames(query?: string): Record<string, unknown>[];
  moderationGames?(): Record<string, unknown>[];
  publicGame(gameId: string, version?: string): Record<string, unknown>;
  moderationGame?(gameId: string, version?: string): Record<string, unknown>;
  resolveVariant(gameId: string, version?: string, architecture?: string): ResolvedVariant;
  resolveVariantForAdmin?(gameId: string, version?: string, architecture?: string): ResolvedVariant;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AdminError("invalid_metadata", 400, message);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) throw new AdminError("invalid_metadata", 400, `${field} is invalid`);
  return value.trim();
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS || value.some((item) => typeof item !== "string" || item.trim().length > MAX_TAG_LENGTH)) {
    throw new AdminError("invalid_metadata", 400, "tags is invalid");
  }
  return value.map((item) => (item as string).trim()).filter(Boolean);
}

function normalizeUpdates(value: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set<string>(REVIEW_EDITABLE_METADATA_FIELDS);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new AdminError("unknown_field", 400, "metadata contains an unknown field");
  if (Object.keys(value).length === 0) throw new AdminError("empty_metadata_update", 400, "metadata update is empty");
  const normalized: Record<string, unknown> = {};
  for (const field of REVIEW_EDITABLE_METADATA_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    normalized[field] = field === "tags" ? tags(value[field]) : text(value[field], field);
  }
  return normalized;
}

function targetId(gameId: string, version: string): string {
  return `${gameId}/${version}`;
}

function adminGameId(value: string): string {
  try { return safeGameId(value); }
  catch { throw new AdminError("invalid_identifier", 400, "cartridge_id is invalid"); }
}

function adminVersion(value: string): string {
  try { return safeVersion(value); }
  catch { throw new AdminError("invalid_identifier", 400, "version is invalid"); }
}

function adminArchitecture(value: string): string {
  try { return normalizeArchitecture(value) as string; }
  catch { throw new AdminError("invalid_filter", 400, "architecture is invalid"); }
}

function publicationFailure(error: unknown): AdminError {
  if (error instanceof AdminError) return error;
  if (error instanceof CatalogError) return new AdminError("catalog_request_invalid", 400, "catalog request is invalid");
  if (error instanceof PublicationConsistencyError) {
    if (error.code === "recovery_required" || error.code === "recovery_ambiguous") {
      return new AdminError("catalog_recovery_required", 503, "catalog operation requires recovery");
    }
    if (error.code === "catalog_not_found" || error.code === "game_not_found" || error.code === "version_not_found") {
      return new AdminError("catalog_not_found", 404, "cartridge not found");
    }
    if (error.code === "unsafe_publication_path" || error.code === "published_artifact_corrupt" || error.code === "published_file_corrupt") {
      return new AdminError("catalog_inconsistent", 409, "published catalog is inconsistent");
    }
    if (error.code === "review_metadata_invalid") return new AdminError("catalog_metadata_invalid", 400, "metadata is invalid");
  }
  return new AdminError("catalog_operation_failed", 500, "catalog operation failed");
}

function catalogReadFailure(error: unknown): AdminError {
  if (error instanceof AdminError) return error;
  if (error instanceof CatalogError && /not found|invalid version/i.test(error.message)) {
    return new AdminError("catalog_not_found", 404, "cartridge not found");
  }
  if (error instanceof CatalogError) return new AdminError("catalog_inconsistent", 409, "published catalog is inconsistent");
  return new AdminError("catalog_operation_failed", 500, "catalog operation failed");
}

function projection(catalog: AdminCatalogRead, game: Record<string, unknown>): AdminCartridgeView {
  const id = typeof game.id === "string" ? game.id : "";
  const selectedVersion = typeof game.selected_version === "string" ? game.selected_version : "";
  const rawVariants = game.variants;
  if (!id || !selectedVersion || rawVariants === null || typeof rawVariants !== "object" || Array.isArray(rawVariants)) {
    throw new AdminError("catalog_inconsistent", 409, "published catalog is inconsistent");
  }
  const variants: Record<string, AdminCartridgeVariant> = {};
  let artifactState: AdminCartridgeView["artifact_state"] = "available";
  for (const [architecture, raw] of Object.entries(rawVariants as Record<string, unknown>)) {
    const variant = object(raw, "catalog variant is malformed");
    const size = typeof variant.size === "number" ? variant.size : 0;
    const sha256 = typeof variant.sha256 === "string" ? variant.sha256 : "";
    try {
      const resolved = (catalog.resolveVariantForAdmin ?? catalog.resolveVariant).call(catalog, id, selectedVersion, architecture);
      if (!sha256 || fileSha256(resolved.filePath) !== sha256) artifactState = "inconsistent";
    } catch {
      artifactState = "unavailable";
    }
    variants[architecture] = {
      architecture,
      size,
      sha256,
      icon_mime: typeof variant.icon_mime === "string" ? variant.icon_mime : null,
      screenshot_mime: typeof variant.screenshot_mime === "string" ? variant.screenshot_mime : null,
      has_screenshot: variant.has_screenshot === true,
      has_signature: variant.has_signature === true,
      updated_at: variant.updated_at ?? null
    };
  }
  const moderationAction = game.moderation_action === "hidden" || game.moderation_action === "unpublished" ? game.moderation_action : "visible";
  return {
    id,
    title: typeof game.title === "string" ? game.title : id,
    summary: typeof game.summary === "string" ? game.summary : "",
    authors: Array.isArray(game.authors) ? game.authors : [],
    tags: Array.isArray(game.tags) ? game.tags : [],
    latest_version: game.latest_version ?? null,
    selected_version: selectedVersion,
    versions: Array.isArray(game.versions) ? game.versions.map(String) : [],
    architectures: Array.isArray(game.architectures) ? game.architectures.map(String) : [],
    metadata: game.metadata !== null && typeof game.metadata === "object" && !Array.isArray(game.metadata) ? game.metadata as Record<string, unknown> : null,
    colophon: game.colophon !== null && typeof game.colophon === "object" && !Array.isArray(game.colophon) ? game.colophon as Record<string, unknown> : null,
    variants,
    publisher: typeof game.publisher === "string" ? game.publisher : "",
    updated_at: game.updated_at ?? null,
    publication_state: "published",
    artifact_state: artifactState,
    moderation_action: moderationAction,
    moderation_reason: typeof game.moderation_reason === "string" ? game.moderation_reason : "",
    moderation_updated_at: game.moderation_updated_at ?? null
  };
}

export class CatalogAdminService {
  private readonly catalog: AdminCatalogRead;
  private readonly publication: PublicationConsistencyService | null;
  private readonly audit: AdminAuditLog;
  private readonly moderationDatabase: Database.Database | null;

  constructor(options: { readonly config: BackendConfig; readonly publication: PublicationConsistencyService | null; readonly audit?: AdminAuditLog; readonly catalog?: AdminCatalogRead; readonly moderationDatabase?: Database.Database | null }) {
    this.catalog = options.catalog ?? new ReadonlyCatalog(options.config.storeDataDirectory);
    this.publication = options.publication;
    this.audit = options.audit ?? new AdminAuditLog(options.config);
    this.moderationDatabase = options.moderationDatabase ?? null;
  }

  recordRejected(actorUserId: number, targetIdValue: string, action: string, requestId: string): void {
    this.audit.rejected(actorUserId, "cartridge", targetIdValue, action, requestId);
  }

  list(options: CatalogListOptions): { readonly cartridges: readonly AdminCartridgeView[]; readonly page: number; readonly limit: number; readonly total: number } {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const page = Math.max(options.page, 1);
    const query = options.query?.trim().toLowerCase();
    if (query !== undefined && query.length > MAX_QUERY_LENGTH) throw new AdminError("invalid_filter", 400, "q is invalid");
    const requestedVersion = options.version === undefined ? undefined : adminVersion(options.version);
    const architecture = options.architecture === undefined ? undefined : adminArchitecture(options.architecture);
    const all = this.catalog.listGames().filter((game) => {
      const values = [game.id, game.title, game.summary, ...(Array.isArray(game.tags) ? game.tags.map(String) : [])].map(String).join(" ").toLowerCase();
      if (query && !values.includes(query)) return false;
      if (requestedVersion !== undefined && !(Array.isArray(game.versions) && game.versions.includes(requestedVersion))) return false;
      if (architecture !== undefined && !(Array.isArray(game.architectures) && game.architectures.includes(architecture))) return false;
      return true;
    }).sort((left, right) => `${String(left.title).toLowerCase()}\u0000${String(left.id)}`.localeCompare(`${String(right.title).toLowerCase()}\u0000${String(right.id)}`));
    const total = all.length;
    const start = (page - 1) * limit;
    try {
      return {
        cartridges: all.slice(start, start + limit).map((game) => projection(this.catalog, requestedVersion === undefined ? game : this.catalog.publicGame(String(game.id), requestedVersion))),
        page,
        limit,
        total
      };
    } catch (error) { throw catalogReadFailure(error); }
  }

  detail(gameId: string, version?: string): AdminCartridgeView {
    const safeId = adminGameId(gameId);
    const safeSelectedVersion = version === undefined ? undefined : adminVersion(version);
    try { return projection(this.catalog, this.catalog.publicGame(safeId, safeSelectedVersion)); }
    catch (error) { throw catalogReadFailure(error); }
  }

  moderationList(options: CatalogListOptions): { readonly cartridges: readonly AdminCartridgeView[]; readonly page: number; readonly limit: number; readonly total: number } {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const page = Math.max(options.page, 1);
    const query = options.query?.trim().toLowerCase();
    if (query !== undefined && query.length > MAX_QUERY_LENGTH) throw new AdminError("invalid_filter", 400, "q is invalid");
    const source = this.catalog.moderationGames?.bind(this.catalog) ?? this.catalog.listGames.bind(this.catalog);
    const all = source().filter((game) => {
      const values = [game.id, game.title, game.summary, ...(Array.isArray(game.tags) ? game.tags.map(String) : [])].map(String).join(" ").toLowerCase();
      if (query && !values.includes(query)) return false;
      if (options.version !== undefined && !(Array.isArray(game.versions) && game.versions.includes(adminVersion(options.version)))) return false;
      if (options.architecture !== undefined && !(Array.isArray(game.architectures) && game.architectures.includes(adminArchitecture(options.architecture)))) return false;
      const moderationAction = game.moderation_action === "hidden" || game.moderation_action === "unpublished" ? game.moderation_action : "visible";
      if (options.moderationAction !== undefined && moderationAction !== options.moderationAction) return false;
      return true;
    }).sort((left, right) => `${String(left.title).toLowerCase()}\u0000${String(left.id)}`.localeCompare(`${String(right.title).toLowerCase()}\u0000${String(right.id)}`));
    const total = all.length;
    const start = (page - 1) * limit;
    try { return { cartridges: all.slice(start, start + limit).map((game) => projection(this.catalog, game)), page, limit, total }; }
    catch (error) { throw catalogReadFailure(error); }
  }

  moderationDetail(gameId: string, version?: string): AdminCartridgeView {
    const safeId = adminGameId(gameId);
    const safeSelectedVersion = version === undefined ? undefined : adminVersion(version);
    try {
      const game = this.catalog.moderationGame?.(safeId, safeSelectedVersion) ?? this.catalog.publicGame(safeId, safeSelectedVersion);
      return projection(this.catalog, game);
    } catch (error) { throw catalogReadFailure(error); }
  }

  update(options: CatalogMutationOptions, context: AdminMutationContext): AdminCartridgeView {
    return this.mutate("catalog.metadata.update", options, context, () => {
      if (!this.publication) throw new AdminError("catalog_write_unavailable", 503, "catalog writes are unavailable");
      const gameId = adminGameId(options.gameId);
      const version = adminVersion(options.version);
      this.publication.mutateCatalog({ gameId, version, metadata: normalizeUpdates(options.metadata ?? {}) });
      return this.detail(gameId, version);
    });
  }

  delete(options: CatalogMutationOptions, context: AdminMutationContext): { readonly id: string; readonly version: string; readonly architecture: string | null; readonly deleted: true } {
    return this.mutate("catalog.delete", options, context, () => {
      if (!this.publication) throw new AdminError("catalog_write_unavailable", 503, "catalog writes are unavailable");
      const gameId = adminGameId(options.gameId);
      const version = adminVersion(options.version);
      const architecture = options.architecture === undefined ? undefined : adminArchitecture(options.architecture);
      this.publication.mutateCatalog({ gameId, version, ...(architecture === undefined ? {} : { architecture }) });
      return { id: gameId, version, architecture: architecture ?? null, deleted: true as const };
    });
  }

  moderate(options: { readonly gameId: string; readonly version: string; readonly action: "hidden" | "unpublished" | "restored"; readonly reason?: string }, context: AdminMutationContext): { readonly id: string; readonly version: string; readonly action: string; readonly reason: string } {
    if (!this.moderationDatabase) throw new AdminError("catalog_moderation_unavailable", 503, "catalog moderation is unavailable");
    const gameId = adminGameId(options.gameId);
    const version = adminVersion(options.version);
    const reason = options.reason?.trim() ?? "";
    if (reason.length > 500) throw new AdminError("catalog_moderation_invalid", 400, "moderation reason is invalid");
    return this.mutate(`catalog.moderation.${options.action}`, { gameId, version }, context, () => {
      const database = this.moderationDatabase as Database.Database;
      database.prepare("UPDATE catalog_moderation SET active = 0 WHERE cartridge_id = ? AND version = ? AND active = 1").run(gameId, version);
      database.prepare("INSERT INTO catalog_moderation(cartridge_id, version, action, reason, actor_user_id, created_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)").run(gameId, version, options.action, reason, context.actorUserId, new Date().toISOString());
      return { id: gameId, version, action: options.action, reason };
    });
  }

  private mutate<T>(action: string, options: CatalogMutationOptions, context: AdminMutationContext, callback: () => T): T {
    const gameId = adminGameId(options.gameId);
    const version = adminVersion(options.version);
    const id = targetId(gameId, version);
    this.audit.ensureReady();
    this.audit.append({ actor_user_id: context.actorUserId, target_type: "cartridge", target_id: id, action, outcome: "attempted", request_id: context.requestId });
    try {
      const result = callback();
      try { this.audit.append({ actor_user_id: context.actorUserId, target_type: "cartridge", target_id: id, action, outcome: "committed", request_id: context.requestId }); } catch { /* the filesystem journal is already durable */ }
      return result;
    } catch (error) {
      try { this.audit.append({ actor_user_id: context.actorUserId, target_type: "cartridge", target_id: id, action, outcome: "failed", request_id: context.requestId }); } catch { /* preserve stable public error */ }
      throw publicationFailure(error);
    }
  }
}
