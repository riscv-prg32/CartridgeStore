import fs from "node:fs";
import path from "node:path";

import { parseCartridge } from "../../submission/prg32.js";
import { TARGET_SCHEMA_VERSION, TARGET_STORAGE_LAYOUT_VERSION } from "../types.js";
import { assertDatabaseUnchanged, openLegacySnapshot } from "./database.js";
import {
  canonicalJson,
  hashFile,
  readBounded,
  parseBoundedJson,
  parseBoundedJsonText,
  relativeSourceRef,
  resolveLegacyReference,
  sha256Bytes,
  stableFileFingerprint,
  walkTree,
  type WalkEntry
} from "./filesystem.js";
import {
  LEGACY_MANIFEST_ABI,
  LEGACY_MANIFEST_VERSION,
  MAX_CARTRIDGE_BYTES,
  MAX_CATALOG_BYTES,
  MAX_DIAGNOSTICS,
  type LegacyAnomaly,
  type LegacyArtifactEntry,
  type LegacyCartridgeEntry,
  type LegacyInventoryResult,
  type LegacyManifest,
  type LegacyMediaEntry,
  type LegacyReleaseEntry,
  type LegacySnapshotConfig,
  type LegacySourceFile,
  type LegacySubmissionArtifactEntry,
  type LegacySubmissionEntry,
  type LegacyTelemetryEvent,
  type LegacyTelemetryInventory
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ARCHITECTURES = new Set(["esp32c6", "qemu"]);
const SENSITIVE_KEY = /(password|passwd|token|secret|cookie|private.?key|credential)/iu;

export class LegacyInventoryError extends Error {
  readonly code: string;
  readonly anomalies: readonly LegacyAnomaly[];

  constructor(message: string, code = "legacy_inventory_invalid", anomalies: readonly LegacyAnomaly[] = [], options?: ErrorOptions) {
    super(message);
    this.name = "LegacyInventoryError";
    this.code = code;
    this.anomalies = anomalies;
    if (options?.cause) this.cause = options.cause;
  }
}

interface CatalogDocument {
  readonly abi: string | null;
  readonly rawFingerprint: string;
  readonly games: Record<string, unknown>;
  readonly compatibility: Readonly<Record<string, unknown>>;
}

interface ScanContext {
  readonly config: LegacySnapshotConfig;
  readonly anomalies: LegacyAnomaly[];
  readonly sourceFiles: LegacySourceFile[];
}

function anomaly(
  anomalies: LegacyAnomaly[],
  code: string,
  severity: LegacyAnomaly["severity"],
  entity: string,
  description: string,
  migrationImpact: string
): void {
  if (anomalies.length >= MAX_DIAGNOSTICS) return;
  anomalies.push({ code, severity, entity, description: description.slice(0, 1_000), migrationImpact: migrationImpact.slice(0, 1_000) });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function safeJsonValue(value: unknown, anomalies: LegacyAnomaly[], entity: string): unknown {
  if (Array.isArray(value)) return value.map((item) => safeJsonValue(item, anomalies, entity));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      if (SENSITIVE_KEY.test(key)) {
        anomaly(anomalies, "secret_field_excluded", "BLOCKER", entity, `sensitive field ${key} was excluded from the manifest`, "manual review is required before migration");
        continue;
      }
      result[key] = safeJsonValue(item, anomalies, entity);
    }
    return result;
  }
  return value;
}

function compatibilityFields(value: Record<string, unknown>, known: readonly string[], anomalies: LegacyAnomaly[], entity: string): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (known.includes(key)) continue;
    result[key] = safeJsonValue(item, anomalies, entity);
    anomaly(anomalies, "unknown_compatibility_critical_field", "WARNING", entity, `unknown catalog field ${key} was preserved in compatibility data`, "migration must review whether the field needs a target mapping");
  }
  return result;
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeReferenceLabel(reference: unknown): string {
  return typeof reference === "string" && reference.length <= 512 && !reference.includes("\0") ? reference : "<invalid-reference>";
}

function detectMime(value: Uint8Array): string | null {
  const bytes = Buffer.from(value);
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  return null;
}

function readCatalog(paths: ReturnType<typeof openLegacySnapshot>["paths"], anomalies: LegacyAnomaly[]): CatalogDocument {
  const raw = parseBoundedJson(paths.catalogPath, MAX_CATALOG_BYTES, "legacy index.json");
  const root = object(raw);
  if (!root) throw new LegacyInventoryError("legacy catalog must be a JSON object", "catalog_invalid", anomalies);
  const games = object(root.games);
  if (!games) throw new LegacyInventoryError("legacy catalog games must be an object", "catalog_invalid", anomalies);
  const abi = nullableString(root.abi);
  if (abi !== "prg32-cartridge-store-index-1.0") anomaly(anomalies, "unsupported_catalog_abi", "BLOCKER", "catalog", "legacy catalog ABI is missing or unsupported", "catalog entries cannot be migrated safely");
  const known = ["abi", "updated_at", "games"];
  return {
    abi,
    rawFingerprint: sha256Bytes(readBounded(paths.catalogPath, MAX_CATALOG_BYTES, "legacy index.json")),
    games,
    compatibility: compatibilityFields(root, known, anomalies, "catalog")
  };
}

function hashOptionalFile(context: ScanContext, entry: WalkEntry, kind: LegacySourceFile["kind"]): LegacySourceFile | null {
  if (entry.type === "symlink") {
    anomaly(context.anomalies, "symlink_escape", "BLOCKER", entry.sourceRef, "legacy snapshot contains a symlink in a scanned tree", "the source must be re-created as a symlink-free snapshot");
    return null;
  }
  if (entry.type !== "file") {
    if (entry.type === "other") anomaly(context.anomalies, "invalid_legacy_path", "BLOCKER", entry.sourceRef, "scanned tree contains a non-regular entry", "the entry cannot be mapped safely");
    return null;
  }
  try {
    const hashed = hashFile(entry);
    if (hashed.changedDuringScan) anomaly(context.anomalies, "inconsistent_snapshot", "BLOCKER", entry.sourceRef, "file metadata changed while it was being hashed", "the inventory is not reproducible and must be repeated from a prepared snapshot");
    return { sourceRef: entry.sourceRef, sizeBytes: hashed.sizeBytes, sha256: hashed.sha256, kind };
  } catch {
    anomaly(context.anomalies, "invalid_legacy_path", "BLOCKER", entry.sourceRef, "legacy file could not be hashed as a regular file", "the artifact cannot be migrated safely");
    return null;
  }
}

function resolveArtifactReference(context: ScanContext, filename: unknown, entity: string): { readonly sourceRef: string; readonly absolutePath: string; readonly safe: boolean } {
  const reference = safeReferenceLabel(filename);
  const resolved = resolveLegacyReference(context.config.root, path.resolve(context.config.root, context.config.dataRoot), reference);
  const cartridgeRoot = path.resolve(context.config.root, context.config.cartridgeRoot);
  if (resolved.safe && !pathInside(cartridgeRoot, resolved.absolutePath)) {
    anomaly(context.anomalies, "invalid_legacy_path", "BLOCKER", entity, "catalog reference does not resolve below the configured cartridge root", "the artifact path cannot be trusted");
    return { ...resolved, safe: false };
  }
  if (!resolved.safe) anomaly(context.anomalies, "invalid_legacy_path", "BLOCKER", entity, "catalog reference contains traversal, an absolute path, or a symlink component", "the artifact cannot be migrated safely");
  return resolved;
}

function inventoryEmbeddedMedia(
  context: ScanContext,
  artifactLegacyId: string,
  cartridgeId: string,
  version: string,
  architecture: string,
  sourceRef: string,
  bytes: Buffer,
  variant: Record<string, unknown>
): { readonly media: readonly LegacyMediaEntry[]; readonly metadata: Record<string, unknown> | null; readonly colophon: Record<string, unknown> | null } {
  try {
    const parsed = parseCartridge(bytes);
    if (parsed.metadata) {
      const metadataId = stringValue(parsed.metadata.id);
      const metadataVersion = stringValue(parsed.metadata.version);
      if (metadataId !== cartridgeId || metadataVersion !== version) anomaly(context.anomalies, "ambiguous_artifact_mapping", "BLOCKER", artifactLegacyId, "embedded metadata identity does not match the catalog identity", "the artifact requires manual mapping review");
      const runtime = object(parsed.metadata.runtime);
      if (runtime && stringValue(runtime.architecture) && stringValue(runtime.architecture) !== architecture) anomaly(context.anomalies, "ambiguous_artifact_mapping", "BLOCKER", artifactLegacyId, "embedded architecture does not match the catalog architecture", "the artifact requires manual mapping review");
    }
    const media: LegacyMediaEntry[] = [];
    for (const [kind, value] of [["icon", parsed.icon], ["screenshot", parsed.screenshot]] as const) {
      if (!value) continue;
      media.push({
        legacyId: `${artifactLegacyId}:${kind}`,
        artifactLegacyId,
        cartridgeId,
        version,
        architecture,
        kind,
        sourceRef,
        mediaType: detectMime(value),
        sizeBytes: value.byteLength,
        sha256: sha256Bytes(value),
        mappingStatus: ARCHITECTURES.has(architecture) && detectMime(value) ? "mapped" : "unsupported"
      });
      if (!detectMime(value)) anomaly(context.anomalies, "invalid_metadata_payload", "BLOCKER", `${artifactLegacyId}:${kind}`, "embedded media has an unsupported MIME signature", "media cannot be promoted without a verified MIME type");
    }
    const expectedScreenshot = variant.has_screenshot === true;
    if (expectedScreenshot && !parsed.screenshot) anomaly(context.anomalies, "missing_media_reference", "BLOCKER", artifactLegacyId, "catalog expects a screenshot that is absent from the cartridge", "media mapping is incomplete");
    if (!expectedScreenshot && parsed.screenshot) anomaly(context.anomalies, "unknown_compatibility_critical_field", "WARNING", artifactLegacyId, "cartridge contains a screenshot not declared by the catalog variant", "migration must retain or explicitly exclude the embedded media");
    return { media, metadata: parsed.metadata ? safeJsonValue(parsed.metadata, context.anomalies, `${artifactLegacyId}:metadata`) as Record<string, unknown> : null, colophon: parsed.colophon ? safeJsonValue(parsed.colophon, context.anomalies, `${artifactLegacyId}:colophon`) as Record<string, unknown> : null };
  } catch {
    anomaly(context.anomalies, "invalid_metadata_payload", "BLOCKER", artifactLegacyId, "referenced cartridge is not a valid PRG32 binary or contains invalid metadata", "the artifact cannot be promoted without manual repair");
    return { media: [], metadata: null, colophon: null };
  }
}

function readArtifact(
  context: ScanContext,
  cartridgeId: string,
  version: string,
  architecture: string,
  variant: Record<string, unknown>
): LegacyArtifactEntry {
  const legacyId = `${cartridgeId}@${version}#${architecture}`;
  const resolved = resolveArtifactReference(context, variant.filename, legacyId);
  const expectedSha256 = typeof variant.sha256 === "string" && HASH.test(variant.sha256) ? variant.sha256 : null;
  const expectedSizeBytes = typeof variant.size === "number" && Number.isSafeInteger(variant.size) && variant.size >= 0 ? variant.size : null;
  if (variant.sha256 !== undefined && expectedSha256 === null) anomaly(context.anomalies, "invalid_metadata_payload", "BLOCKER", legacyId, "catalog sha256 is not a lowercase SHA-256 value", "artifact identity cannot be verified");
  if (variant.size !== undefined && expectedSizeBytes === null) anomaly(context.anomalies, "invalid_metadata_payload", "BLOCKER", legacyId, "catalog size is not a non-negative safe integer", "artifact identity cannot be verified");
  let exists = false;
  let regularFile = false;
  let symlinkSafe = resolved.safe;
  let sizeBytes: number | null = null;
  let sha256: string | null = null;
  let media: readonly LegacyMediaEntry[] = [];
  let metadata: Record<string, unknown> | null = null;
  let colophon: Record<string, unknown> | null = null;
  if (resolved.safe && fs.existsSync(resolved.absolutePath)) {
    const stats = fs.lstatSync(resolved.absolutePath);
    regularFile = stats.isFile();
    if (!regularFile || stats.isSymbolicLink()) {
      symlinkSafe = false;
      anomaly(context.anomalies, stats.isSymbolicLink() ? "symlink_escape" : "invalid_legacy_path", "BLOCKER", legacyId, "referenced artifact is not a regular non-symlink file", "artifact cannot be migrated safely");
    } else {
      exists = true;
      const sourceFile = hashOptionalFile(context, { sourceRef: resolved.sourceRef, absolutePath: resolved.absolutePath, type: "file" }, "artifact");
      if (sourceFile) {
        context.sourceFiles.push(sourceFile);
        sizeBytes = sourceFile.sizeBytes;
        sha256 = sourceFile.sha256;
        if (expectedSha256 && expectedSha256 !== sha256) anomaly(context.anomalies, "artifact_hash_mismatch", "BLOCKER", legacyId, "actual artifact SHA-256 differs from catalog metadata", "the artifact cannot be promoted without manual review");
        if (expectedSizeBytes !== null && expectedSizeBytes !== sizeBytes) anomaly(context.anomalies, "artifact_size_mismatch", "BLOCKER", legacyId, "actual artifact size differs from catalog metadata", "the artifact cannot be promoted without manual review");
        if (sizeBytes <= MAX_CARTRIDGE_BYTES) {
          const parsed = inventoryEmbeddedMedia(context, legacyId, cartridgeId, version, architecture, resolved.sourceRef, fs.readFileSync(resolved.absolutePath), variant);
          media = parsed.media;
          metadata = parsed.metadata;
          colophon = parsed.colophon;
        } else {
          anomaly(context.anomalies, "legacy_resource_limit", "BLOCKER", legacyId, "cartridge exceeds the bounded parser size", "the artifact requires a separately approved streaming parser");
        }
      }
    }
  } else if (resolved.safe) {
    anomaly(context.anomalies, "missing_referenced_artifact", "BLOCKER", legacyId, "catalog references a missing cartridge file", "migration cannot proceed with an unresolved public artifact");
  }
  const mappingStatus = exists && symlinkSafe && ARCHITECTURES.has(architecture) && sizeBytes !== null && sha256 !== null ? "mapped" : ARCHITECTURES.has(architecture) ? "blocked" : "unsupported";
  const icon = media.find((item) => item.kind === "icon");
  const screenshot = media.find((item) => item.kind === "screenshot");
  return {
    legacyId,
    cartridgeId,
    version,
    architecture,
    sourceRef: resolved.safe ? resolved.sourceRef : `unsafe:${sha256Bytes(safeReferenceLabel(variant.filename)).slice(0, 16)}`,
    exists,
    regularFile,
    symlinkSafe,
    sizeBytes,
    sha256,
    expectedSizeBytes,
    expectedSha256,
    hashMatches: expectedSha256 === null || sha256 === null ? null : expectedSha256 === sha256,
    sizeMatches: expectedSizeBytes === null || sizeBytes === null ? null : expectedSizeBytes === sizeBytes,
    mappingStatus,
    metadata,
    colophon,
    media,
    publicVariant: {
      architecture,
      filename: resolved.safe ? resolved.sourceRef : variant.filename,
      size: typeof variant.size === "number" ? variant.size : sizeBytes,
      sha256: typeof variant.sha256 === "string" ? variant.sha256 : sha256,
      ...(typeof variant.icon_mime === "string" ? { icon_mime: variant.icon_mime } : icon?.mediaType ? { icon_mime: icon.mediaType } : {}),
      ...(typeof variant.screenshot_mime === "string" ? { screenshot_mime: variant.screenshot_mime } : screenshot?.mediaType ? { screenshot_mime: screenshot.mediaType } : {}),
      ...(variant.has_screenshot !== undefined ? { has_screenshot: variant.has_screenshot } : screenshot ? { has_screenshot: true } : {}),
      ...(variant.has_signature !== undefined ? { has_signature: variant.has_signature } : {}),
      ...(variant.updated_at !== undefined ? { updated_at: variant.updated_at } : {}),
      ...(variant.published_by !== undefined ? { published_by: variant.published_by } : {})
    },
    compatibility: compatibilityFields(variant, ["architecture", "filename", "size", "sha256", "icon_mime", "screenshot_mime", "has_screenshot", "has_signature", "updated_at", "published_by"], context.anomalies, legacyId)
  };
}

function readCatalogEntities(context: ScanContext, catalog: CatalogDocument): { readonly cartridges: readonly LegacyCartridgeEntry[]; readonly releases: readonly LegacyReleaseEntry[]; readonly artifacts: readonly LegacyArtifactEntry[]; readonly media: readonly LegacyMediaEntry[] } {
  const cartridges: LegacyCartridgeEntry[] = [];
  const releases: LegacyReleaseEntry[] = [];
  const artifacts: LegacyArtifactEntry[] = [];
  const seenCartridges = new Set<string>();
  const seenReleases = new Set<string>();
  for (const [key, rawGame] of Object.entries(catalog.games).sort(([left], [right]) => left.localeCompare(right))) {
    const entity = `game:${key}`;
    const game = object(rawGame);
    if (!game) {
      anomaly(context.anomalies, "malformed_catalog_entry", "BLOCKER", entity, "catalog game entry is not an object", "the game cannot be mapped");
      continue;
    }
    const cartridgeId = stringValue(game.id, key);
    if (!SAFE_ID.test(cartridgeId) || cartridgeId.includes("..")) anomaly(context.anomalies, "malformed_catalog_entry", "BLOCKER", entity, "cartridge identifier is unsafe", "the cartridge cannot be mapped safely");
    if (seenCartridges.has(cartridgeId)) anomaly(context.anomalies, "duplicate_cartridge_identity", "BLOCKER", entity, "multiple catalog keys resolve to the same cartridge identifier", "migration identity is ambiguous");
    seenCartridges.add(cartridgeId);
    const versions = object(game.versions);
    if (!versions) {
      anomaly(context.anomalies, "malformed_catalog_entry", "BLOCKER", entity, "catalog versions is not an object", "the cartridge cannot be mapped");
      continue;
    }
    const versionNames = Object.keys(versions).sort();
    cartridges.push({
      cartridgeId,
      title: stringValue(game.title, cartridgeId),
      summary: stringValue(game.summary),
      authors: Array.isArray(game.authors) ? game.authors.map((item) => safeJsonValue(item, context.anomalies, entity)) : [],
      tags: Array.isArray(game.tags) ? game.tags.map((item) => safeJsonValue(item, context.anomalies, entity)) : [],
      latestVersion: nullableString(game.latest_version),
      versions: versionNames,
      compatibility: compatibilityFields(game, ["id", "title", "summary", "authors", "tags", "latest_version", "publisher", "created_at", "updated_at", "versions"], context.anomalies, entity)
    });
    for (const version of versionNames) {
      const releaseEntity = `release:${cartridgeId}@${version}`;
      if (!SAFE_VERSION.test(version) || version.includes("..")) anomaly(context.anomalies, "malformed_catalog_entry", "BLOCKER", releaseEntity, "version identifier is unsafe", "the release cannot be mapped safely");
      const versionRecord = object(versions[version]);
      if (!versionRecord) {
        anomaly(context.anomalies, "malformed_catalog_entry", "BLOCKER", releaseEntity, "catalog version entry is not an object", "the release cannot be mapped");
        continue;
      }
      const architectures = object(versionRecord.architectures);
      if (!architectures) {
        anomaly(context.anomalies, "malformed_catalog_entry", "BLOCKER", releaseEntity, "catalog architectures is not an object", "the release cannot be mapped");
        continue;
      }
      const architectureNames = Object.keys(architectures).sort();
      if (seenReleases.has(`${cartridgeId}@${version}`)) anomaly(context.anomalies, "duplicate_release_version_mapping", "BLOCKER", releaseEntity, "release identity occurs more than once", "release mapping is ambiguous");
      seenReleases.add(`${cartridgeId}@${version}`);
      const releaseArtifacts: LegacyArtifactEntry[] = [];
      for (const architecture of architectureNames) {
        const variant = object(architectures[architecture]);
        if (!variant) {
          anomaly(context.anomalies, "malformed_catalog_entry", "BLOCKER", `${releaseEntity}#${architecture}`, "catalog variant is not an object", "artifact cannot be mapped");
          continue;
        }
        if (!ARCHITECTURES.has(architecture)) anomaly(context.anomalies, "invalid_architecture", "BLOCKER", `${releaseEntity}#${architecture}`, "catalog architecture is not supported by the PRG32 contract", "the variant requires a manual architecture mapping");
        const artifact = readArtifact(context, cartridgeId, version, architecture, variant);
        artifacts.push(artifact);
        releaseArtifacts.push(artifact);
      }
      // The catalog exposes version metadata and colophon. Prefer those
      // public values and only fall back to embedded blocks when the legacy
      // index has no value to expose.
      const metadata = object(versionRecord.metadata)
        ? safeJsonValue(versionRecord.metadata, context.anomalies, releaseEntity) as Record<string, unknown>
        : releaseArtifacts.find((artifact) => artifact.metadata)?.metadata ?? null;
      const colophon = object(versionRecord.colophon)
        ? safeJsonValue(versionRecord.colophon, context.anomalies, releaseEntity) as Record<string, unknown>
        : releaseArtifacts.find((artifact) => artifact.colophon)?.colophon ?? null;
      releases.push({
        legacyId: `${cartridgeId}@${version}`,
        cartridgeId,
        version,
        publishedAt: nullableString(versionRecord.published_at),
        updatedAt: nullableString(versionRecord.updated_at),
        metadata,
        colophon,
        architectures: architectureNames,
        mappingStatus: releaseArtifacts.length > 0 && releaseArtifacts.every((artifact) => artifact.mappingStatus === "mapped") ? "mapped" : "blocked",
        compatibility: compatibilityFields(versionRecord, ["version", "published_at", "updated_at", "metadata", "colophon", "architectures", "published_by"], context.anomalies, releaseEntity)
      });
    }
  }
  return { cartridges: cartridges.sort((left, right) => left.cartridgeId.localeCompare(right.cartridgeId)), releases: releases.sort((left, right) => left.legacyId.localeCompare(right.legacyId)), artifacts: artifacts.sort((left, right) => left.legacyId.localeCompare(right.legacyId)), media: artifacts.flatMap((artifact) => artifact.media).sort((left, right) => left.legacyId.localeCompare(right.legacyId)) };
}

function inventoryCartridgeFiles(context: ScanContext, referenced: ReadonlySet<string>): LegacySourceFile[] {
  const files: LegacySourceFile[] = [];
  const entries = walkTree(context.config.root, path.resolve(context.config.root, context.config.cartridgeRoot));
  for (const entry of entries) {
    const file = hashOptionalFile(context, entry, "artifact");
    if (!file) continue;
    files.push(file);
    if (!referenced.has(file.sourceRef)) anomaly(context.anomalies, "unreferenced_artifact_file", "WARNING", file.sourceRef, "cartridge file is not referenced by index.json", "file is retained as migration evidence but is not catalog authority");
  }
  return files;
}

function inventorySiteAssets(context: ScanContext): LegacySourceFile[] {
  if (!context.config.mediaRoot) return [];
  const entries = walkTree(context.config.root, path.resolve(context.config.root, context.config.mediaRoot));
  const files: LegacySourceFile[] = [];
  for (const entry of entries) {
    const file = hashOptionalFile(context, entry, "site_asset");
    if (file) files.push(file);
  }
  return files;
}

function parseRowJson(value: unknown, entity: string, context: ScanContext): unknown {
  if (typeof value !== "string") {
    anomaly(context.anomalies, "invalid_metadata_payload", "BLOCKER", entity, "database JSON field is not text", "record cannot be mapped");
    return null;
  }
  try {
    return parseBoundedJsonText(value, 2 * 1024 * 1024, entity);
  } catch {
    anomaly(context.anomalies, "invalid_metadata_payload", "BLOCKER", entity, "database JSON field is invalid or exceeds limits", "record cannot be mapped");
    return null;
  }
}

function inventorySubmissions(context: ScanContext, snapshot: ReturnType<typeof openLegacySnapshot>): LegacySubmissionEntry[] {
  const rows = snapshot.sqlite.prepare("SELECT * FROM cartridge_submissions ORDER BY id ASC").all() as Array<Record<string, unknown>>;
  const userIds = new Set((snapshot.sqlite.prepare("SELECT id FROM users ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id));
  const submissions: LegacySubmissionEntry[] = [];
  const statuses: Record<string, string> = { pending: "pending_review", verified: "approved", approved: "approved", rejected: "rejected", cancelled: "cancelled", published: "published" };
  for (const row of rows) {
    const submissionId = nullableInteger(row.id);
    const entity = `submission:${submissionId ?? "invalid"}`;
    if (submissionId === null) {
      anomaly(context.anomalies, "invalid_submission_state", "BLOCKER", entity, "submission ID is not a safe integer", "submission identity cannot be preserved");
      continue;
    }
    const sourceStatus = stringValue(row.status);
    const targetStatus = statuses[sourceStatus] ?? null;
    if (!targetStatus) anomaly(context.anomalies, "invalid_submission_state", "BLOCKER", entity, `unsupported submission state ${sourceStatus}`, "submission lifecycle requires manual mapping");
    for (const key of ["submitted_by_user_id", "reviewed_by_user_id"] as const) {
      const userId = nullableInteger(row[key]);
      if (userId !== null && !userIds.has(userId)) anomaly(context.anomalies, "orphaned_submission_reference", "BLOCKER", entity, `${key} references a missing user`, "submission ownership/reviewer relationship cannot be preserved");
    }
    const architecturesValue = parseRowJson(row.architectures_json, entity, context);
    const architectureRows: LegacySubmissionArtifactEntry[] = [];
    if (!Array.isArray(architecturesValue)) {
      anomaly(context.anomalies, "invalid_submission_state", "BLOCKER", entity, "architectures_json is not an array", "submission artifacts cannot be mapped");
    } else {
      for (const raw of architecturesValue) {
        const item = object(raw);
        const architecture = stringValue(item?.architecture);
        const stored = stringValue(item?.stored);
        const itemEntity = `${entity}#${architecture || "invalid"}`;
        if (!ARCHITECTURES.has(architecture)) anomaly(context.anomalies, "invalid_architecture", "BLOCKER", itemEntity, "submission architecture is unsupported", "submission artifact requires manual mapping");
        const resolved = resolveLegacyReference(context.config.root, path.resolve(context.config.root, context.config.dataRoot), stored);
        const submissionRoot = context.config.submissionRoot ? path.resolve(context.config.root, context.config.submissionRoot) : null;
        const safe = resolved.safe && submissionRoot !== null && pathInside(submissionRoot, resolved.absolutePath);
        if (!safe) anomaly(context.anomalies, "invalid_legacy_path", "BLOCKER", itemEntity, "submission staging reference escapes the configured submission root", "staging bytes cannot be mapped safely");
        let exists = false;
        let sizeBytes: number | null = null;
        let sha256: string | null = null;
        if (safe && fs.existsSync(resolved.absolutePath) && fs.lstatSync(resolved.absolutePath).isFile()) {
          exists = true;
          const sourceFile = hashOptionalFile(context, { sourceRef: resolved.sourceRef, absolutePath: resolved.absolutePath, type: "file" }, "submission");
          if (sourceFile) {
            context.sourceFiles.push(sourceFile);
            sizeBytes = sourceFile.sizeBytes;
            sha256 = sourceFile.sha256;
          }
        } else if (safe) {
          anomaly(context.anomalies, "missing_submission_staging_file", "BLOCKER", itemEntity, "submission references a missing staging file", "submission cannot be resumed safely");
        }
        architectureRows.push({ architecture, sourceRef: safe ? resolved.sourceRef : `unsafe:${sha256Bytes(stored).slice(0, 16)}`, exists, sizeBytes, sha256, mappingStatus: exists && ARCHITECTURES.has(architecture) ? "mapped" : ARCHITECTURES.has(architecture) ? "blocked" : "unsupported" });
      }
    }
    const pendingDir = stringValue(row.pending_dir);
    const pendingResolved = pendingDir ? resolveLegacyReference(context.config.root, path.resolve(context.config.root, context.config.dataRoot), pendingDir) : null;
    const safePendingDir = pendingResolved?.safe && context.config.submissionRoot !== null && context.config.submissionRoot !== undefined && pathInside(path.resolve(context.config.root, context.config.submissionRoot), pendingResolved.absolutePath) ? pendingResolved.sourceRef : null;
    if (pendingDir && !safePendingDir) anomaly(context.anomalies, "invalid_legacy_path", "BLOCKER", entity, "submission pending directory is unsafe", "submission staging cannot be mapped");
    const metadataValue = parseRowJson(row.metadata_json, entity, context);
    const metadata = object(metadataValue) ? safeJsonValue(metadataValue, context.anomalies, entity) as Record<string, unknown> : null;
    submissions.push({ submissionId, cartridgeId: stringValue(row.game_id), version: stringValue(row.version), sourceStatus, targetStatus, submittedByUserId: nullableInteger(row.submitted_by_user_id), reviewedByUserId: nullableInteger(row.reviewed_by_user_id), createdAt: stringValue(row.created_at), reviewedAt: nullableString(row.reviewed_at), stagingDirectory: safePendingDir, artifacts: architectureRows.sort((left, right) => left.architecture.localeCompare(right.architecture)), metadata, mappingStatus: targetStatus && architectureRows.every((item) => item.mappingStatus === "mapped") ? "mapped" : "blocked" });
  }
  return submissions;
}

function inventoryTelemetry(context: ScanContext, snapshot: ReturnType<typeof openLegacySnapshot>, artifacts: readonly LegacyArtifactEntry[]): LegacyTelemetryInventory {
  const rows = snapshot.sqlite.prepare("SELECT id, game_id, version, architecture, user_id, downloaded_at FROM download_events ORDER BY id ASC").all() as Array<Record<string, unknown>>;
  const byIdentity = new Map<string, LegacyArtifactEntry[]>();
  for (const artifact of artifacts) {
    const key = `${artifact.cartridgeId}\0${artifact.version}\0${artifact.architecture}`;
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), artifact]);
  }
  const events: LegacyTelemetryEvent[] = [];
  for (const row of rows) {
    const eventId = nullableInteger(row.id);
    const cartridgeId = stringValue(row.game_id);
    const version = stringValue(row.version);
    const architecture = stringValue(row.architecture);
    const matches = byIdentity.get(`${cartridgeId}\0${version}\0${architecture}`) ?? [];
    const mappingStatus = matches.length === 1 ? "mapped" : matches.length === 0 ? "unmapped" : "ambiguous";
    if (mappingStatus === "unmapped") anomaly(context.anomalies, "unmappable_download_event", "WARNING", `download:${eventId ?? "invalid"}`, "download event has no unique catalog artifact mapping", "event will be preserved as an unresolved migration exception");
    if (mappingStatus === "ambiguous") anomaly(context.anomalies, "ambiguous_artifact_mapping", "WARNING", `download:${eventId ?? "invalid"}`, "download event maps to more than one artifact", "event will be preserved as an unresolved migration exception");
    events.push({ eventId: eventId ?? -1, cartridgeId, version, architecture, userId: nullableInteger(row.user_id), downloadedAt: stringValue(row.downloaded_at), artifactLegacyId: matches.length === 1 ? matches[0]?.legacyId ?? null : null, mappingStatus });
  }
  return { eventCount: events.length, mappedCount: events.filter((event) => event.mappingStatus === "mapped").length, unmappedCount: events.filter((event) => event.mappingStatus === "unmapped").length, ambiguousCount: events.filter((event) => event.mappingStatus === "ambiguous").length, events };
}

function buildReadiness(anomalies: readonly LegacyAnomaly[]) {
  const blockers = anomalies.filter((item) => item.severity === "BLOCKER").length;
  const warnings = anomalies.filter((item) => item.severity === "WARNING").length;
  return {
    inventoryComplete: true as const,
    migrationReady: blockers === 0,
    operationalCutoverReady: false as const,
    blockingAnomalyCount: blockers,
    warningCount: warnings,
    rationale: blockers === 0 ? ["snapshot components were scanned", "no blocking anomalies were found", "operational cutover remains separately gated"] : ["snapshot was scanned completely", `${blockers} blocking anomalies require manual intervention`, "operational cutover remains separately gated"]
  };
}

export function inventoryLegacySnapshot(config: LegacySnapshotConfig): LegacyInventoryResult {
  const context: ScanContext = { config, anomalies: [], sourceFiles: [] };
  const snapshot = openLegacySnapshot(config);
  const initialDatabaseFingerprint = snapshot.database.databaseFingerprint;
  try {
    const catalog = readCatalog(snapshot.paths, context.anomalies);
    const entities = readCatalogEntities(context, catalog);
    const referenced = new Set(entities.artifacts.map((artifact) => artifact.sourceRef));
    const cartridgeFiles = inventoryCartridgeFiles(context, referenced);
    const siteAssetFiles = inventorySiteAssets(context);
    context.sourceFiles.push(...cartridgeFiles, ...siteAssetFiles);
    const submissions = inventorySubmissions(context, snapshot);
    const telemetry = inventoryTelemetry(context, snapshot, entities.artifacts);
    if (snapshot.database.foreignKeyViolations.length > 0) anomaly(context.anomalies, "foreign_key_violation", "BLOCKER", "database", "legacy database has foreign-key violations", "the source database must be repaired or explicitly excepted before migration");
    assertDatabaseUnchanged(snapshot, initialDatabaseFingerprint);
    const allFiles = [...new Map(context.sourceFiles.map((file) => [file.sourceRef, file])).values()].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
    const referencedFiles = new Set(entities.artifacts.map((artifact) => artifact.sourceRef));
    const unreferencedFiles = [...cartridgeFiles, ...siteAssetFiles].filter((file) => !referencedFiles.has(file.sourceRef)).sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
    const source = {
      snapshotAbi: "prg32-legacy-snapshot-1.0",
      schemaFingerprint: snapshot.database.schemaFingerprint,
      databaseFingerprint: snapshot.database.databaseFingerprint,
      catalogFingerprint: catalog.rawFingerprint,
      storageInventoryFingerprint: stableFileFingerprint(allFiles),
      databaseWalPresent: snapshot.database.walPresent,
      databaseShmPresent: snapshot.database.shmPresent,
      paths: {
        database: relativeSourceRef(snapshot.paths.root, snapshot.paths.databasePath),
        catalog: relativeSourceRef(snapshot.paths.root, snapshot.paths.catalogPath),
        dataRoot: relativeSourceRef(snapshot.paths.root, snapshot.paths.dataRoot),
        cartridgeRoot: relativeSourceRef(snapshot.paths.root, snapshot.paths.cartridgeRoot),
        submissionRoot: snapshot.paths.submissionRoot ? relativeSourceRef(snapshot.paths.root, snapshot.paths.submissionRoot) : null,
        mediaRoot: snapshot.paths.mediaRoot ? relativeSourceRef(snapshot.paths.root, snapshot.paths.mediaRoot) : null
      }
    };
    const preManifest = {
      manifestAbi: LEGACY_MANIFEST_ABI,
      manifestVersion: LEGACY_MANIFEST_VERSION,
      source,
      target: { schemaVersion: TARGET_SCHEMA_VERSION, storageLayoutVersion: TARGET_STORAGE_LAYOUT_VERSION },
      summary: { cartridges: entities.cartridges.length, releases: entities.releases.length, artifacts: entities.artifacts.length, media: entities.media.length, submissions: submissions.length, downloadEvents: telemetry.eventCount, sourceFiles: allFiles.length, unreferencedFiles: unreferencedFiles.length },
      database: snapshot.database,
      cartridges: entities.cartridges,
      releases: entities.releases,
      artifacts: entities.artifacts,
      media: entities.media,
      submissions,
      telemetry,
      sourceFiles: allFiles,
      unreferencedFiles,
      anomalies: [...context.anomalies].sort((left, right) => `${left.severity}:${left.code}:${left.entity}`.localeCompare(`${right.severity}:${right.code}:${right.entity}`)),
      readiness: buildReadiness(context.anomalies)
    };
    const manifestSha256 = sha256Bytes(canonicalJson(preManifest));
    const manifest = { ...preManifest, manifestSha256 } as LegacyManifest;
    return { manifest, canonicalManifest: `${canonicalJson(manifest)}\n`, humanReport: renderValidationReport(manifest) };
  } finally {
    snapshot.close();
  }
}

export function renderValidationReport(manifest: LegacyManifest): string {
  const blockers = manifest.anomalies.filter((item) => item.severity === "BLOCKER");
  const warnings = manifest.anomalies.filter((item) => item.severity === "WARNING");
  const lines = [
    "# PRG32 legacy snapshot inventory report",
    "",
    `- Manifest ABI: ${manifest.manifestAbi}`,
    `- Manifest SHA-256: ${manifest.manifestSha256}`,
    `- Inventory complete: ${manifest.readiness.inventoryComplete}`,
    `- Migration ready: ${manifest.readiness.migrationReady}`,
    "- Operational cutover ready: false",
    "",
    "## Summary",
    "",
    ...Object.entries(manifest.summary).map(([key, value]) => `- ${key}: ${value}`),
    "",
    `## Anomalies (${manifest.anomalies.length})`,
    "",
    `- BLOCKER: ${blockers.length}`,
    `- WARNING: ${warnings.length}`,
    `- INFO: ${manifest.anomalies.length - blockers.length - warnings.length}`,
    "",
    ...manifest.anomalies.map((item) => `- [${item.severity}] ${item.code} — ${item.entity}: ${item.description}`),
    "",
    "## Decision",
    "",
    manifest.readiness.migrationReady ? "The snapshot is eligible for a separately authorized M5.2c migration rehearsal." : "The snapshot is not eligible for migration until blocking anomalies are resolved.",
    "Operational cutover remains out of scope."
  ];
  return `${lines.join("\n")}\n`;
}
