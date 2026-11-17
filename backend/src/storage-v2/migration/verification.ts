import crypto from "node:crypto";
import type Database from "better-sqlite3";

import { auditStorage } from "../integrity.js";
import { openLegacySnapshot } from "../legacy/database.js";
import { canonicalJson } from "../legacy/filesystem.js";
import type { LegacyManifest, LegacySnapshotConfig } from "../legacy/types.js";
import { openTargetStorage } from "../database.js";
import { artifactId, cartridgeId, mediaId, releaseId } from "./planner.js";
import type { MigrationVerificationResult } from "./types.js";

const COMPATIBLE_TABLES = ["users", "groups", "user_groups", "api_tokens", "registration_tokens", "store_settings", "scores", "runs", "samples"] as const;

function normalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { buffer: value.toString("hex") };
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}

function tableColumns(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; cid: number }>)
    .sort((left, right) => left.cid - right.cid)
    .map((row) => row.name);
}

function tableFingerprint(source: Database.Database, target: Database.Database, table: string): string {
  const digest = crypto.createHash("sha256");
  const targetColumns = new Set(tableColumns(target, table));
  // Administrative status columns are additive to the Fastify target and are
  // intentionally excluded from the legacy compatibility fingerprint. Their
  // Defaults must not make an otherwise identical storage snapshot fail parity.
  const compatibilityOnly = new Set([
    "account_status",
    "display_name",
    "status_reason",
    "status_actor_user_id",
    "status_changed_at",
    "status_expires_at",
  ]);
  const columns = tableColumns(source, table).filter((column) => targetColumns.has(column) && !compatibilityOnly.has(column));
  if (columns.length === 0) return digest.digest("hex");
  const projection = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ");
  for (const row of source.prepare(`SELECT ${projection} FROM "${table}" ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
    digest.update(canonicalJson(normalize(row)), "utf8");
    digest.update("\n", "utf8");
  }
  return digest.digest("hex");
}

function count(sqlite: Database.Database, table: string): number {
  return Number((sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count);
}

function mismatch(mismatches: string[], value: string): void {
  if (mismatches.length < 2_000) mismatches.push(value);
}

function verifyLogicalContent(target: Database.Database, manifest: LegacyManifest, mismatches: string[]): void {
  const expectedCounts: Record<string, number> = {
    cartridges: manifest.summary.cartridges,
    releases: manifest.summary.releases,
    artifacts: manifest.summary.artifacts,
    media: manifest.summary.media,
    submissions: manifest.summary.submissions,
    submission_artifacts: manifest.submissions.reduce((sum, item) => sum + item.artifacts.filter((artifact) => artifact.mappingStatus === "mapped").length, 0),
    download_events: manifest.telemetry.mappedCount,
    site_assets: manifest.sourceFiles.filter((item) => item.kind === "site_asset").length
  };
  for (const [table, expected] of Object.entries(expectedCounts)) {
    const actual = count(target, table);
    if (actual !== expected) mismatch(mismatches, `${table}: expected ${expected}, found ${actual}`);
  }
  for (const cartridge of manifest.cartridges) {
    const row = target.prepare("SELECT cartridge_id FROM cartridges WHERE cartridge_id = ?").get(cartridgeId(cartridge.cartridgeId));
    if (!row) mismatch(mismatches, `missing cartridge ${cartridge.cartridgeId}`);
  }
  for (const release of manifest.releases) {
    const row = target.prepare("SELECT release_id, cartridge_id, version, state FROM releases WHERE release_id = ?").get(releaseId(release.legacyId)) as Record<string, unknown> | undefined;
    if (!row || row.cartridge_id !== release.cartridgeId || row.version !== release.version || row.state !== "published") mismatch(mismatches, `release mapping mismatch ${release.legacyId}`);
  }
  for (const artifact of manifest.artifacts) {
    const row = target.prepare(
      `SELECT a.artifact_id, a.release_id, a.architecture, a.state, o.sha256, o.size_bytes, o.state AS object_state
       FROM artifacts a JOIN storage_objects o ON o.object_id = a.object_id WHERE a.artifact_id = ?`
    ).get(artifactId(artifact.legacyId)) as Record<string, unknown> | undefined;
    if (!row || row.release_id !== releaseId(`${artifact.cartridgeId}@${artifact.version}`) || row.architecture !== artifact.architecture || row.state !== "published" || row.object_state !== "available" || row.sha256 !== artifact.sha256 || row.size_bytes !== artifact.sizeBytes) {
      mismatch(mismatches, `artifact mapping mismatch ${artifact.legacyId}`);
    }
  }
  for (const media of manifest.media) {
    const row = target.prepare(
      `SELECT m.media_id, m.release_id, m.architecture, m.kind, o.sha256, o.size_bytes, o.state
       FROM media m JOIN storage_objects o ON o.object_id = m.object_id WHERE m.media_id = ?`
    ).get(mediaId(media.legacyId)) as Record<string, unknown> | undefined;
    if (!row || row.release_id !== releaseId(`${media.cartridgeId}@${media.version}`) || row.architecture !== media.architecture || row.kind !== media.kind || row.sha256 !== media.sha256 || row.size_bytes !== media.sizeBytes || row.state !== "available") {
      mismatch(mismatches, `media mapping mismatch ${media.legacyId}`);
    }
  }
  for (const asset of manifest.sourceFiles.filter((item) => item.kind === "site_asset")) {
    const assetKey = asset.sourceRef.replaceAll("/", "_").replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128) || "legacy_asset";
    const row = target.prepare(
      `SELECT s.asset_key, o.sha256, o.size_bytes, o.state
       FROM site_assets s JOIN storage_objects o ON o.object_id = s.object_id WHERE s.asset_key = ?`
    ).get(assetKey) as Record<string, unknown> | undefined;
    if (!row || row.sha256 !== asset.sha256 || row.size_bytes !== asset.sizeBytes || row.state !== "available") mismatch(mismatches, `site asset mapping mismatch ${asset.sourceRef}`);
  }
  const expectedOrder = [...manifest.releases].sort((left, right) => `${left.publishedAt ?? left.updatedAt ?? "1970-01-01T00:00:00.000Z"}:${left.legacyId}`.localeCompare(`${right.publishedAt ?? right.updatedAt ?? "1970-01-01T00:00:00.000Z"}:${right.legacyId}`)).map((item) => releaseId(item.legacyId));
  const actualOrder = (target.prepare("SELECT release_id FROM releases WHERE state = 'published' ORDER BY published_order ASC").pluck().all() as string[]);
  if (canonicalJson(actualOrder) !== canonicalJson(expectedOrder)) mismatch(mismatches, "publication ordering mismatch");
  for (const submission of manifest.submissions) {
    const row = target.prepare("SELECT submission_id, cartridge_id, version, status, legacy_submission_id FROM submissions WHERE submission_id = ?").get(submission.submissionId) as Record<string, unknown> | undefined;
    if (!row || row.cartridge_id !== submission.cartridgeId || row.version !== submission.version || row.status !== submission.targetStatus || row.legacy_submission_id !== submission.submissionId) mismatch(mismatches, `submission mapping mismatch ${submission.submissionId}`);
    for (const artifact of submission.artifacts.filter((item) => item.mappingStatus === "mapped")) {
      const artifactRow = target.prepare("SELECT sha256, size_bytes, architecture FROM submission_artifacts WHERE submission_id = ? AND architecture = ?").get(submission.submissionId, artifact.architecture) as Record<string, unknown> | undefined;
      if (!artifactRow || artifactRow.architecture !== artifact.architecture || artifactRow.sha256 !== artifact.sha256 || artifactRow.size_bytes !== artifact.sizeBytes) mismatch(mismatches, `submission artifact mapping mismatch ${submission.submissionId}:${artifact.architecture}`);
    }
  }
  for (const event of manifest.telemetry.events.filter((item) => item.mappingStatus === "mapped")) {
    const row = target.prepare("SELECT id, cartridge_id, release_id, artifact_id, version, architecture, user_id, downloaded_at FROM download_events WHERE id = ?").get(event.eventId) as Record<string, unknown> | undefined;
    if (!row || row.cartridge_id !== event.cartridgeId || row.release_id !== releaseId(`${event.cartridgeId}@${event.version}`) || row.artifact_id !== artifactId(event.artifactLegacyId ?? "") || row.version !== event.version || row.architecture !== event.architecture || row.user_id !== event.userId || row.downloaded_at !== event.downloadedAt) mismatch(mismatches, `download event mapping mismatch ${event.eventId}`);
  }
  const exceptions = count(target, "migration_exceptions");
  const expectedExceptions = manifest.telemetry.unmappedCount + manifest.telemetry.ambiguousCount;
  if (exceptions !== expectedExceptions) mismatch(mismatches, `migration exceptions: expected ${expectedExceptions}, found ${exceptions}`);
}

export function verifyMigratedTarget(snapshotConfig: LegacySnapshotConfig, manifest: LegacyManifest, targetRoot: string, migrationIdValue: string): MigrationVerificationResult {
  const target = openTargetStorage(targetRoot, "read-only");
  const mismatches: string[] = [];
  let source: ReturnType<typeof openLegacySnapshot> | null = null;
  try {
    const audit = auditStorage(target.sqlite, target.paths);
    source = openLegacySnapshot(snapshotConfig);
    for (const table of COMPATIBLE_TABLES) {
      if (tableFingerprint(source.sqlite, target.sqlite, table) !== tableFingerprint(target.sqlite, target.sqlite, table)) mismatch(mismatches, `compatible table fingerprint mismatch ${table}`);
    }
    verifyLogicalContent(target.sqlite, manifest, mismatches);
    const operation = target.sqlite.prepare("SELECT state FROM publication_operations WHERE operation_id = ?").get(migrationIdValue) as { state: string } | undefined;
    if (!operation || operation.state !== "completed") mismatch(mismatches, "migration publication operation is not completed");
    const expectedOperationItems = manifest.artifacts.length + manifest.media.length + manifest.sourceFiles.filter((item) => item.kind === "site_asset").length;
    const actualOperationItems = count(target.sqlite, "publication_operation_items");
    if (actualOperationItems !== expectedOperationItems) mismatch(mismatches, `publication operation items: expected ${expectedOperationItems}, found ${actualOperationItems}`);
    const exceptionCount = count(target.sqlite, "migration_exceptions");
    return {
      ok: audit.ok && mismatches.length === 0,
      migrationId: migrationIdValue,
      targetAuditOk: audit.ok,
      differentialOk: mismatches.length === 0,
      counts: {
        cartridges: count(target.sqlite, "cartridges"),
        releases: count(target.sqlite, "releases"),
        artifacts: count(target.sqlite, "artifacts"),
        media: count(target.sqlite, "media"),
        submissions: count(target.sqlite, "submissions"),
        submissionArtifacts: count(target.sqlite, "submission_artifacts"),
        downloads: count(target.sqlite, "download_events"),
        exceptions: exceptionCount
      },
      mismatches,
      exceptionCount
    };
  } finally {
    source?.close();
    target.close();
  }
}
