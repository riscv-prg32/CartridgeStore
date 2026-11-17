import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import {
  CatalogError,
  normalizeArchitecture,
  paginateCatalog,
  safeGameId,
  safeVersion,
  type ResolvedVariant
} from "../catalog/catalog.js";
import { openTargetStorage, TARGET_ROOT_MARKER } from "./database.js";
import { ReadonlyObjectStore } from "./objects.js";
import { TARGET_APPLICATION, type StorageDatabase } from "./types.js";

type JsonRecord = Record<string, unknown>;

export interface ResolvedCatalogMedia {
  readonly filePath: string;
  readonly mediaType: string;
}

export interface CanonicalCatalogOptions {
  readonly legacyRoots?: readonly string[];
  readonly operational?: boolean;
}

function jsonParse(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as unknown; } catch { return fallback; }
}

function recordValue(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function insideOrContains(left: string, right: string): boolean {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  const relative = path.relative(rightResolved, leftResolved);
  const leftInsideRight = relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  const reverse = path.relative(leftResolved, rightResolved);
  const rightInsideLeft = reverse === "" || (!reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse));
  return leftInsideRight || rightInsideLeft;
}

export function assertExplicitDisposableRoot(rootValue: string, legacyRoots: readonly string[] = []): string {
  if (!rootValue.trim() || rootValue.split(/[\\/]/u).includes("..")) throw new Error("canonical disposable storage root is invalid");
  const root = path.resolve(rootValue);
  const workingDirectory = path.resolve(process.cwd());
  const forbidden = [
    ...(workingDirectory === path.parse(workingDirectory).root
      ? []
      : [workingDirectory]),
    ...legacyRoots,
  ].filter(Boolean);
  if (forbidden.some((candidate) => insideOrContains(root, candidate))) throw new Error("canonical disposable storage root overlaps an operational or repository root");
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) throw new Error("canonical disposable storage root is unavailable");
  const marker = path.join(root, TARGET_ROOT_MARKER);
  if (!fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink() || !fs.lstatSync(marker).isFile()) throw new Error("canonical disposable storage marker is missing");
  if (fs.readFileSync(marker, "utf8") !== `${TARGET_APPLICATION}\n`) throw new Error("canonical disposable storage marker is invalid");
  return root;
}

export function assertExplicitOperationalRoot(rootValue: string): string {
  if (!rootValue.trim() || rootValue.split(/[\\/]/u).includes("..")) throw new Error("canonical operational storage root is invalid");
  const root = path.resolve(rootValue);
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) throw new Error("canonical operational storage root is unavailable");
  const marker = path.join(root, TARGET_ROOT_MARKER);
  if (!fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink() || !fs.lstatSync(marker).isFile()) throw new Error("canonical operational storage marker is missing");
  if (fs.readFileSync(marker, "utf8") !== `${TARGET_APPLICATION}\n`) throw new Error("canonical operational storage marker is invalid");
  return root;
}

function latestRelease(sqlite: Database.Database, cartridgeId: string, version?: string): JsonRecord | null {
  const row = version === undefined
    ? sqlite.prepare("SELECT * FROM releases WHERE cartridge_id = ? AND state = 'published' ORDER BY published_order DESC, release_id DESC LIMIT 1").get(cartridgeId)
    : sqlite.prepare("SELECT * FROM releases WHERE cartridge_id = ? AND version = ? AND state = 'published' ORDER BY revision DESC LIMIT 1").get(cartridgeId, version);
  return (row as JsonRecord | undefined) ?? null;
}

function legacyVariant(sqlite: Database.Database, releaseId: string, architecture: string): JsonRecord | null {
  const row = sqlite.prepare(
    `SELECT a.architecture, a.compatibility_json, o.object_id, o.sha256, o.size_bytes
       FROM artifacts a JOIN storage_objects o ON o.object_id = a.object_id
      WHERE a.release_id = ? AND a.architecture = ? AND a.state = 'published' AND o.state = 'available'`
  ).get(releaseId, architecture) as JsonRecord | undefined;
  if (!row) return null;
  const compatibility = recordValue(jsonParse(row.compatibility_json, {}));
  const legacy = recordValue(compatibility?.legacyPublicVariant);
  const media = sqlite.prepare(
    `SELECT m.kind, o.media_type
       FROM media m JOIN storage_objects o ON o.object_id = m.object_id
      WHERE m.release_id = ? AND m.kind IN ('icon', 'screenshot')
        AND o.state = 'available' AND (m.architecture = ? OR m.architecture = '')
      ORDER BY CASE WHEN m.architecture = ? THEN 0 ELSE 1 END`
  ).all(releaseId, architecture, architecture) as Array<{ kind?: string; media_type?: string }>;
  const icon = media.find((item) => item.kind === "icon");
  const screenshot = media.find((item) => item.kind === "screenshot");
  return {
    ...(legacy ?? { architecture, size: Number(row.size_bytes), sha256: String(row.sha256), has_screenshot: false, has_signature: false }),
    ...(icon?.media_type ? { icon_mime: icon.media_type } : {}),
    ...(screenshot?.media_type ? { screenshot_mime: screenshot.media_type, has_screenshot: true } : {})
  };
}

function matchesQuery(game: JsonRecord, needle: string): boolean {
  const authors = Array.isArray(game.authors) ? game.authors.map((item) => {
    if (item !== null && typeof item === "object" && typeof (item as JsonRecord).name === "string") return String((item as JsonRecord).name);
    return typeof item === "string" ? item : "";
  }).join(" ") : "";
  const tags = Array.isArray(game.tags) ? game.tags.filter((item): item is string => typeof item === "string") : [];
  return [String(game.id), String(game.title), String(game.summary), ...tags, authors].join(" ").toLowerCase().includes(needle);
}

function moderationBlocks(sqlite: Database.Database, cartridgeId: string, version?: string): boolean {
  const row = version === undefined
    ? sqlite.prepare("SELECT action FROM catalog_moderation WHERE cartridge_id = ? AND active = 1 ORDER BY created_at DESC, moderation_id DESC LIMIT 1").get(cartridgeId)
    : sqlite.prepare("SELECT action FROM catalog_moderation WHERE cartridge_id = ? AND version = ? AND active = 1 ORDER BY created_at DESC, moderation_id DESC LIMIT 1").get(cartridgeId, version);
  return (row as { action?: string } | undefined)?.action === "hidden" || (row as { action?: string } | undefined)?.action === "unpublished";
}

export class CanonicalCatalog {
  readonly root: string;
  private readonly resource: StorageDatabase;
  private readonly objects: ReadonlyObjectStore;

  constructor(rootValue: string, options: CanonicalCatalogOptions = {}) {
    this.root = options.operational ? assertExplicitOperationalRoot(rootValue) : assertExplicitDisposableRoot(rootValue, options.legacyRoots ?? []);
    this.resource = openTargetStorage(this.root, "read-only");
    this.objects = new ReadonlyObjectStore(this.resource.sqlite, this.resource.paths);
  }

  close(): void { this.resource.close(); }

  isReadOnly(): boolean { return Number(this.resource.sqlite.pragma("query_only", { simple: true })) === 1; }

  storeName(fallback: string): string {
    const row = this.resource.sqlite
      .prepare("SELECT value FROM store_settings WHERE key = 'store_name'")
      .get() as { value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value.trim() ? row.value : fallback;
  }

  listGames(query?: string): JsonRecord[] {
    const rows = this.resource.sqlite.prepare(
      "SELECT c.cartridge_id FROM cartridges c WHERE c.state = 'active' AND EXISTS (SELECT 1 FROM releases r WHERE r.cartridge_id = c.cartridge_id AND r.state = 'published') ORDER BY c.cartridge_id"
    ).all() as Array<{ cartridge_id: string }>;
    const needle = query?.trim().toLowerCase() ?? "";
    return rows.filter((row) => !moderationBlocks(this.resource.sqlite, row.cartridge_id)).map((row) => this.publicGame(row.cartridge_id)).filter((game) => !needle || matchesQuery(game, needle))
      .sort((left, right) => String(left.title).toLowerCase().localeCompare(String(right.title).toLowerCase()));
  }

  /** Admin-only projection: moderation must remain searchable after public filtering. */
  moderationGames(): JsonRecord[] {
    const rows = this.resource.sqlite.prepare(
      "SELECT c.cartridge_id FROM cartridges c WHERE c.state = 'active' AND EXISTS (SELECT 1 FROM releases r WHERE r.cartridge_id = c.cartridge_id AND r.state = 'published') ORDER BY c.cartridge_id"
    ).all() as Array<{ cartridge_id: string }>;
    return rows.map(({ cartridge_id }) => {
      const game = this.catalogGame(cartridge_id, undefined, false);
      const moderation = this.resource.sqlite.prepare(
        "SELECT action, reason, created_at FROM catalog_moderation WHERE cartridge_id = ? AND version = ? AND active = 1 ORDER BY created_at DESC, moderation_id DESC LIMIT 1"
      ).get(cartridge_id, String(game.selected_version)) as { action?: string; reason?: string; created_at?: string } | undefined;
      return {
        ...game,
        moderation_action: moderation?.action ?? "visible",
        moderation_reason: moderation?.reason ?? "",
        moderation_updated_at: moderation?.created_at ?? null
      };
    });
  }

  moderationGame(cartridgeIdValue: string, versionValue?: string): JsonRecord {
    const game = this.catalogGame(cartridgeIdValue, versionValue, false);
    const moderation = this.resource.sqlite.prepare(
      "SELECT action, reason, created_at FROM catalog_moderation WHERE cartridge_id = ? AND version = ? AND active = 1 ORDER BY created_at DESC, moderation_id DESC LIMIT 1"
    ).get(safeGameId(cartridgeIdValue), String(game.selected_version)) as { action?: string; reason?: string; created_at?: string } | undefined;
    return { ...game, moderation_action: moderation?.action ?? "visible", moderation_reason: moderation?.reason ?? "", moderation_updated_at: moderation?.created_at ?? null };
  }

  publicGame(cartridgeIdValue: string, versionValue?: string): JsonRecord {
    return this.catalogGame(cartridgeIdValue, versionValue, true);
  }

  private catalogGame(cartridgeIdValue: string, versionValue: string | undefined, enforceModeration: boolean): JsonRecord {
    const cartridgeId = safeGameId(cartridgeIdValue);
    const version = versionValue === undefined ? undefined : safeVersion(versionValue);
    if (enforceModeration && moderationBlocks(this.resource.sqlite, cartridgeId, version)) throw new CatalogError("game not found");
    const cartridge = this.resource.sqlite.prepare("SELECT * FROM cartridges WHERE cartridge_id = ? AND state = 'active'").get(cartridgeId) as JsonRecord | undefined;
    if (!cartridge) throw new CatalogError("game not found");
    const selectedRelease = latestRelease(this.resource.sqlite, cartridgeId, version);
    if (!selectedRelease) throw new CatalogError("version not found");
    const currentRelease = latestRelease(this.resource.sqlite, cartridgeId);
    if (!currentRelease) throw new CatalogError("version not found");
    const releases = this.resource.sqlite.prepare("SELECT version FROM releases WHERE cartridge_id = ? AND state = 'published'").all(cartridgeId) as Array<{ version: string }>;
    const artifacts = this.resource.sqlite.prepare("SELECT architecture FROM artifacts WHERE release_id = ? AND state = 'published' ORDER BY architecture").all(selectedRelease.release_id) as Array<{ architecture: string }>;
    const variants: JsonRecord = {};
    for (const item of artifacts) {
      const value = legacyVariant(this.resource.sqlite, String(selectedRelease.release_id), item.architecture);
      if (!value) throw new CatalogError("artifact is unavailable");
      variants[item.architecture] = value;
    }
    const publisherUserId = typeof cartridge.publisher_user_id === "number"
      ? cartridge.publisher_user_id
      : typeof currentRelease.created_by_user_id === "number"
        ? currentRelease.created_by_user_id
        : null;
    const publisher = publisherUserId === null
      ? null
      : this.resource.sqlite.prepare("SELECT username FROM users WHERE id = ?").get(publisherUserId) as { username?: string } | undefined;

    return {
      id: cartridgeId,
      title: String(currentRelease.title),
      summary: typeof currentRelease.summary === "string" ? currentRelease.summary : "",
      authors: jsonParse(currentRelease.authors_json, []),
      tags: jsonParse(currentRelease.tags_json, []),
      latest_version: String(currentRelease.version),
      selected_version: String(selectedRelease.version),
      versions: releases.map((item) => item.version).sort(),
      architectures: Object.keys(variants).sort(),
      metadata: jsonParse(selectedRelease.metadata_json, null),
      colophon: selectedRelease.colophon_json ? jsonParse(selectedRelease.colophon_json, null) : null,
      variants,
      publisher: typeof publisher?.username === "string" ? publisher.username : "",
      updated_at: String(currentRelease.published_at ?? currentRelease.created_at)
    };
  }

  resolveVariant(gameIdValue: string, versionValue?: string, architectureValue?: string): ResolvedVariant {
    return this.resolveVariantInternal(gameIdValue, versionValue, architectureValue, true);
  }

  resolveVariantForAdmin(gameIdValue: string, versionValue?: string, architectureValue?: string): ResolvedVariant {
    return this.resolveVariantInternal(gameIdValue, versionValue, architectureValue, false);
  }

  private resolveVariantInternal(gameIdValue: string, versionValue: string | undefined, architectureValue: string | undefined, enforceModeration: boolean): ResolvedVariant {
    const game = this.catalogGame(gameIdValue, versionValue, enforceModeration);
    const variants = recordValue(game.variants) ?? {};
    const architecture = normalizeArchitecture(architectureValue) ?? (Object.hasOwn(variants, "esp32c6") ? "esp32c6" : Object.keys(variants).sort()[0]);
    if (!architecture || !Object.hasOwn(variants, architecture)) throw new CatalogError("architecture not found");
    const release = latestRelease(this.resource.sqlite, safeGameId(gameIdValue), String(game.selected_version));
    if (!release) throw new CatalogError("version not found");
    const artifact = this.resource.sqlite.prepare("SELECT object_id FROM artifacts WHERE release_id = ? AND architecture = ? AND state = 'published'").get(release.release_id, architecture) as { object_id?: string } | undefined;
    if (!artifact?.object_id) throw new CatalogError("architecture not found");
    let resolved;
    try { resolved = this.objects.resolve(artifact.object_id, "artifact"); } catch { throw new CatalogError("cartridge file is unavailable"); }
    if (!this.objects.verify(artifact.object_id).ok) throw new CatalogError("cartridge file is unavailable");
    const variant = recordValue(variants[architecture]);
    if (!variant) throw new CatalogError("invalid variant");
    return { game, publicGame: game, variant, architecture, filePath: resolved.filePath, version: String(game.selected_version) };
  }

  resolveMedia(gameIdValue: string, versionValue: string | undefined, architectureValue: string | undefined, kind: "icon" | "screenshot"): ResolvedCatalogMedia {
    const game = this.publicGame(gameIdValue, versionValue);
    const release = latestRelease(this.resource.sqlite, safeGameId(gameIdValue), String(game.selected_version));
    if (!release) throw new CatalogError("version not found");
    const architectures = Array.isArray(game.architectures) ? game.architectures.map(String) : [];
    const selected = normalizeArchitecture(architectureValue) ?? (architectures.includes("esp32c6") ? "esp32c6" : String(architectures[0] ?? ""));
    if (!selected) throw new CatalogError("architecture not found");
    const media = this.resource.sqlite.prepare(
      `SELECT m.object_id, o.media_type FROM media m JOIN storage_objects o ON o.object_id = m.object_id
        WHERE m.release_id = ? AND m.kind = ? AND o.state = 'available' AND (m.architecture = ? OR m.architecture = '')
        ORDER BY CASE WHEN m.architecture = ? THEN 0 ELSE 1 END LIMIT 1`
    ).get(release.release_id, kind, selected, selected) as { object_id?: string; media_type?: string } | undefined;
    if (!media?.object_id || !media.media_type) throw new CatalogError(`${kind} not found`);
    let resolved;
    try { resolved = this.objects.resolve(media.object_id, "media"); } catch { throw new CatalogError(`${kind} not found`); }
    if (!this.objects.verify(media.object_id).ok) throw new CatalogError(`${kind} not found`);
    return { filePath: resolved.filePath, mediaType: media.media_type };
  }

  colophon(gameIdValue: string, versionValue?: string): JsonRecord {
    const game = this.publicGame(gameIdValue, versionValue);
    if (game.colophon === null || typeof game.colophon !== "object" || Array.isArray(game.colophon)) throw new CatalogError("colophon not found");
    return game.colophon as JsonRecord;
  }

  paginate(items: readonly JsonRecord[], query: Record<string, unknown>): Record<string, unknown> { return paginateCatalog(items, query); }
}
