import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { openTargetStorage, initializeDisposableStorage, isDisposablePath } from "../database.js";
import { ObjectStore, readStorageObjectRow } from "../objects.js";
import { parseCartridge } from "../../submission/prg32.js";
import {
  canonicalJson,
  hashFile,
  readBounded,
  writeAtomic
} from "../legacy/filesystem.js";
import { openLegacySnapshot } from "../legacy/database.js";
import {
  MAX_CARTRIDGE_BYTES,
  type LegacyArtifactEntry,
  type LegacyManifest,
  type LegacyMediaEntry,
  type LegacySnapshotConfig,
  type LegacySourceFile,
  type LegacySubmissionEntry
} from "../legacy/types.js";
import { appendCheckpoint, newMigrationJournal, readMigrationJournal, updateMigrationJournal, writeMigrationJournal } from "./journal.js";
import {
  artifactId,
  decisionId,
  exceptionId,
  mediaId,
  objectId,
  planMigration,
  releaseId,
  siteAssetKey,
  submissionArtifactId
} from "./planner.js";
import { verifyMigratedTarget } from "./verification.js";
import {
  DISPOSABLE_MIGRATION_AUTHORIZATION,
  type MigrationConfig,
  type MigrationJournal,
  type MigrationPhase,
  type MigrationPlan,
  type MigrationResult
} from "./types.js";

const DEFAULT_MIGRATION_TIMESTAMP = "1970-01-01T00:00:00.000Z";
export { MigrationError } from "./errors.js";
import { MigrationError } from "./errors.js";
import {
  loadMigrationManifest,
  sourceFilePath,
  targetFilePath,
  validateMigrationManifest,
  validateMigrationRoots,
  verifyMigrationSource,
} from "./validation.js";
import { copyCompatibleTable } from "./table-transfer.js";

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function ensureOperation(target: Database.Database, plan: MigrationPlan): void {
  const existing = target.prepare("SELECT manifest_json FROM publication_operations WHERE operation_id = ?").get(plan.migrationId) as { manifest_json: string } | undefined;
  const manifest = json({ abi: "prg32-storage-v2-migration-1.0", migrationId: plan.migrationId, manifestSha256: plan.manifestSha256, targetSchemaVersion: plan.targetSchemaVersion, targetStorageLayoutVersion: plan.targetStorageLayoutVersion });
  if (existing) {
    if (existing.manifest_json !== manifest) throw new MigrationError("target migration operation conflicts with source manifest", "migration_target_conflict");
    return;
  }
  target.prepare(
    `INSERT INTO publication_operations(operation_id, operation_kind, state, manifest_json, created_at, updated_at)
     VALUES (?, 'migration', 'prepared', ?, ?, ?)`
  ).run(plan.migrationId, manifest, now(), now());
}

function ensurePublicationItem(target: Database.Database, operationId: string, kind: "artifact" | "media" | "site_asset", architecture: string, role: "artifact" | "icon" | "screenshot" | "site_asset", object: { objectId: string; storageKey: string; sha256: string; sizeBytes: number }): void {
  const existing = target.prepare("SELECT * FROM publication_operation_items WHERE operation_id = ? AND expected_object_id = ?").get(operationId, object.objectId) as Record<string, unknown> | undefined;
  if (existing) {
    if (existing.item_kind !== kind || existing.architecture !== architecture || existing.target_role !== role || existing.expected_sha256 !== object.sha256 || existing.expected_size_bytes !== object.sizeBytes) throw new MigrationError("target publication item conflicts with source object", "migration_target_conflict");
    return;
  }
  target.prepare(
    `INSERT INTO publication_operation_items(operation_item_id, operation_id, item_kind, architecture, target_role, expected_object_id, target_storage_key, expected_sha256, expected_size_bytes, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified')`
  ).run(`item_${crypto.createHash("sha256").update(`${operationId}:${object.objectId}`).digest("hex").slice(0, 32)}`, operationId, kind, architecture, role, object.objectId, object.storageKey, object.sha256, object.sizeBytes);
}

/** A migration-only wrapper avoids exposing the target database as public API. */
function existingObject(store: ObjectStore, target: Database.Database, objectValue: { objectId: string; objectKind: "artifact" | "media" | "site_asset"; sha256: string; sizeBytes: number; mediaType: string }): boolean {
  const existing = readStorageObjectRow(target, objectValue.objectId);
  if (!existing) return false;
  if (existing.objectKind !== objectValue.objectKind || existing.sha256 !== objectValue.sha256 || existing.sizeBytes !== objectValue.sizeBytes || existing.mediaType !== objectValue.mediaType || existing.state !== "available") throw new MigrationError("existing target object conflicts with source identity", "migration_object_conflict");
  if (!store.verify(objectValue.objectId).ok) throw new MigrationError("existing target object failed integrity verification", "migration_object_integrity_failed");
  return true;
}

function createCartridgesAndReleases(target: Database.Database, manifest: LegacyManifest): void {
  const insertCartridge = target.prepare("INSERT INTO cartridges(cartridge_id, created_at, updated_at, publisher_user_id, state) VALUES (?, ?, ?, NULL, 'active')");
  const insertRelease = target.prepare(
    `INSERT INTO releases(release_id, cartridge_id, version, revision, state, title, summary, authors_json, tags_json, metadata_json, colophon_json, created_at)
     VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?)`
  );
  const cartridgeById = new Map(manifest.cartridges.map((item) => [item.cartridgeId, item]));
  target.transaction(() => {
    for (const cartridge of manifest.cartridges) {
      const existing = target.prepare("SELECT cartridge_id, state FROM cartridges WHERE cartridge_id = ?").get(cartridge.cartridgeId) as Record<string, unknown> | undefined;
      if (!existing) insertCartridge.run(cartridge.cartridgeId, DEFAULT_MIGRATION_TIMESTAMP, DEFAULT_MIGRATION_TIMESTAMP);
      else if (existing.state !== "active") throw new MigrationError("target cartridge conflicts with source state", "migration_target_conflict");
    }
    for (const release of manifest.releases) {
      const game = cartridgeById.get(release.cartridgeId);
      if (!game) throw new MigrationError("release references an unknown cartridge", "migration_mapping_invalid");
      const artifactMetadata = manifest.artifacts.find((item) => item.cartridgeId === release.cartridgeId && item.version === release.version)?.metadata ?? null;
      const metadata = release.metadata ?? artifactMetadata ?? {};
      const createdAt = release.updatedAt ?? release.publishedAt ?? DEFAULT_MIGRATION_TIMESTAMP;
      const existing = target.prepare("SELECT cartridge_id, version, revision, title, metadata_json FROM releases WHERE release_id = ?").get(releaseId(release.legacyId)) as Record<string, unknown> | undefined;
      if (!existing) insertRelease.run(releaseId(release.legacyId), release.cartridgeId, release.version, game.title, game.summary, json(game.authors), json(game.tags), json(metadata), release.colophon ? json(release.colophon) : null, createdAt);
      else if (existing.cartridge_id !== release.cartridgeId || existing.version !== release.version || existing.revision !== 1 || existing.title !== game.title || existing.metadata_json !== json(metadata)) throw new MigrationError("target release conflicts with source identity", "migration_target_conflict");
    }
  })();
}

function sourcePathForManifest(config: LegacySnapshotConfig, sourceRef: string): string {
  return sourceFilePath(config, sourceRef);
}

function ensureArtifact(pathsRoot: string, config: LegacySnapshotConfig, artifact: LegacyArtifactEntry, operationId: string): void {
  if (artifact.mappingStatus !== "mapped" || artifact.sha256 === null || artifact.sizeBytes === null) throw new MigrationError("artifact is not migration-ready", "migration_artifact_not_ready");
  const source = sourcePathForManifest(config, artifact.sourceRef);
  const sourceBefore = hashFile({ sourceRef: artifact.sourceRef, absolutePath: source });
  if (sourceBefore.sha256 !== artifact.sha256 || sourceBefore.sizeBytes !== artifact.sizeBytes || sourceBefore.changedDuringScan) throw new MigrationError("artifact source identity changed", "migration_source_changed");
  const targetResource = openTargetStorage(pathsRoot, "read-write");
  try {
    const store = new ObjectStore(targetResource.sqlite, targetResource.paths);
    const objectValue = { objectId: objectId("artifact", artifact.legacyId, artifact.sha256), objectKind: "artifact" as const, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, mediaType: "application/vnd.prg32.cartridge" };
    if (!existingObject(store, targetResource.sqlite, objectValue)) store.storeFile("artifact", objectValue.mediaType, { sourcePath: source, objectId: objectValue.objectId, createdByOperationId: operationId });
    const after = hashFile({ sourceRef: artifact.sourceRef, absolutePath: source });
    if (after.sha256 !== artifact.sha256 || after.sizeBytes !== artifact.sizeBytes || after.changedDuringScan) throw new MigrationError("artifact source changed during promotion", "migration_source_changed");
    const existingRelationship = targetResource.sqlite.prepare("SELECT release_id, architecture, object_id, state FROM artifacts WHERE artifact_id = ?").get(artifactId(artifact.legacyId)) as Record<string, unknown> | undefined;
    const compatibility = json({ ...artifact.compatibility, legacyPublicVariant: artifact.publicVariant });
    if (!existingRelationship) targetResource.sqlite.prepare("INSERT INTO artifacts(artifact_id, release_id, architecture, object_id, compatibility_json, state, created_at) VALUES (?, ?, ?, ?, ?, 'staged', ?)").run(artifactId(artifact.legacyId), releaseId(`${artifact.cartridgeId}@${artifact.version}`), artifact.architecture, objectValue.objectId, compatibility, now());
    else if (existingRelationship.release_id !== releaseId(`${artifact.cartridgeId}@${artifact.version}`) || existingRelationship.architecture !== artifact.architecture || existingRelationship.object_id !== objectValue.objectId) throw new MigrationError("target artifact relationship conflicts with source", "migration_target_conflict");
    ensurePublicationItem(targetResource.sqlite, operationId, "artifact", artifact.architecture, "artifact", { ...objectValue, storageKey: `storage/objects/artifacts/${objectValue.objectId}.prg32` });
  } finally {
    targetResource.close();
  }
}

function mediaBytes(config: LegacySnapshotConfig, artifact: LegacyArtifactEntry, media: LegacyMediaEntry): Buffer {
  if (artifact.sizeBytes === null || artifact.sizeBytes > MAX_CARTRIDGE_BYTES) throw new MigrationError("media source artifact exceeds the bounded parser limit", "migration_media_limit");
  const bytes = readBounded(sourcePathForManifest(config, artifact.sourceRef), MAX_CARTRIDGE_BYTES, "legacy cartridge");
  const parsed = parseCartridge(bytes);
  const value = media.kind === "icon" ? parsed.icon : parsed.screenshot;
  if (!value || value.byteLength !== media.sizeBytes || crypto.createHash("sha256").update(value).digest("hex") !== media.sha256) throw new MigrationError("embedded media identity does not match manifest", "migration_media_conflict");
  if (value.byteLength > 16 * 1024 * 1024) throw new MigrationError("embedded media exceeds the migration limit", "migration_media_limit");
  return Buffer.from(value);
}

function ensureMedia(targetRoot: string, config: LegacySnapshotConfig, artifacts: readonly LegacyArtifactEntry[], media: LegacyMediaEntry, operationId: string): void {
  if (media.mappingStatus !== "mapped" || !media.mediaType) throw new MigrationError("media is not migration-ready", "migration_media_not_ready");
  const artifact = artifacts.find((item) => item.legacyId === media.artifactLegacyId);
  if (!artifact) throw new MigrationError("media references an unknown artifact", "migration_mapping_invalid");
  const resource = openTargetStorage(targetRoot, "read-write");
  try {
    const store = new ObjectStore(resource.sqlite, resource.paths);
    const bytes = mediaBytes(config, artifact, media);
    const objectValue = { objectId: objectId("media", media.legacyId, media.sha256), objectKind: "media" as const, sha256: media.sha256, sizeBytes: media.sizeBytes, mediaType: media.mediaType };
    if (!existingObject(store, resource.sqlite, objectValue)) store.store("media", bytes, objectValue.mediaType, { objectId: objectValue.objectId, createdByOperationId: operationId });
    const existing = resource.sqlite.prepare("SELECT release_id, architecture, kind, object_id FROM media WHERE media_id = ?").get(mediaId(media.legacyId)) as Record<string, unknown> | undefined;
    if (!existing) resource.sqlite.prepare("INSERT INTO media(media_id, release_id, architecture, kind, object_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(mediaId(media.legacyId), releaseId(`${media.cartridgeId}@${media.version}`), media.architecture, media.kind, objectValue.objectId, now());
    else if (existing.release_id !== releaseId(`${media.cartridgeId}@${media.version}`) || existing.architecture !== media.architecture || existing.kind !== media.kind || existing.object_id !== objectValue.objectId) throw new MigrationError("target media relationship conflicts with source", "migration_target_conflict");
    ensurePublicationItem(resource.sqlite, operationId, "media", media.architecture, media.kind, { ...objectValue, storageKey: `storage/objects/media/${objectValue.objectId}.${media.mediaType === "image/jpeg" ? "jpg" : "png"}` });
  } finally {
    resource.close();
  }
}

function siteAssetMediaType(sourceRef: string): string {
  const extension = path.extname(sourceRef).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function ensureSiteAsset(targetRoot: string, config: LegacySnapshotConfig, file: LegacySourceFile, operationId: string): void {
  const source = sourcePathForManifest(config, file.sourceRef);
  const resource = openTargetStorage(targetRoot, "read-write");
  try {
    const store = new ObjectStore(resource.sqlite, resource.paths);
    const mediaType = siteAssetMediaType(file.sourceRef);
    const objectValue = { objectId: objectId("site_asset", file.sourceRef, file.sha256), objectKind: "site_asset" as const, sha256: file.sha256, sizeBytes: file.sizeBytes, mediaType };
    if (!existingObject(store, resource.sqlite, objectValue)) store.storeFile("site_asset", mediaType, { sourcePath: source, objectId: objectValue.objectId, createdByOperationId: operationId });
    const assetKey = siteAssetKey(file.sourceRef);
    const existing = resource.sqlite.prepare("SELECT asset_key, object_id FROM site_assets WHERE asset_id = ?").get(`asset_${crypto.createHash("sha256").update(file.sourceRef).digest("hex").slice(0, 32)}`) as Record<string, unknown> | undefined;
    if (!existing) resource.sqlite.prepare("INSERT INTO site_assets(asset_id, asset_key, object_id, state, created_at) VALUES (?, ?, ?, 'active', ?)").run(`asset_${crypto.createHash("sha256").update(file.sourceRef).digest("hex").slice(0, 32)}`, assetKey, objectValue.objectId, now());
    else if (existing.asset_key !== assetKey || existing.object_id !== objectValue.objectId) throw new MigrationError("target site asset conflicts with source", "migration_target_conflict");
    ensurePublicationItem(resource.sqlite, operationId, "site_asset", "", "site_asset", { ...objectValue, storageKey: `storage/objects/site-assets/${objectValue.objectId}.${mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : mediaType === "image/svg+xml" ? "svg" : "bin"}` });
  } finally {
    resource.close();
  }
}

function copySubmissionFile(targetRoot: string, config: LegacySnapshotConfig, submissionId: number, architecture: string, sourceRef: string, expectedSha: string, expectedSize: number): string {
  const source = sourcePathForManifest(config, sourceRef);
  const relative = `storage/staging/submissions/${submissionId}/artifacts/${architecture}.prg32`;
  const destination = targetFilePath(targetRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) {
    const existing = hashFile({ sourceRef: relative, absolutePath: destination });
    if (existing.sha256 !== expectedSha || existing.sizeBytes !== expectedSize) throw new MigrationError("target submission staging conflicts with source", "migration_target_conflict");
    return relative;
  }
  const before = hashFile({ sourceRef, absolutePath: source });
  if (before.sha256 !== expectedSha || before.sizeBytes !== expectedSize || before.changedDuringScan) throw new MigrationError("submission source identity changed", "migration_source_changed");
  fs.copyFileSync(source, destination);
  const after = hashFile({ sourceRef: relative, absolutePath: destination });
  if (after.sha256 !== expectedSha || after.sizeBytes !== expectedSize) throw new MigrationError("submission staging verification failed", "migration_target_integrity_failed");
  return relative;
}

function ensureSubmission(target: Database.Database, targetRoot: string, config: LegacySnapshotConfig, manifestSubmission: LegacySubmissionEntry, source: Database.Database): void {
  if (!manifestSubmission.targetStatus) throw new MigrationError("submission status is not migration-ready", "migration_submission_not_ready");
  const row = source.prepare("SELECT * FROM cartridge_submissions WHERE id = ?").get(manifestSubmission.submissionId) as Record<string, unknown> | undefined;
  if (!row) throw new MigrationError("submission disappeared from source snapshot", "migration_source_changed");
  const publishedRelease = manifestSubmission.targetStatus === "published" ? releaseId(`${manifestSubmission.cartridgeId}@${manifestSubmission.version}`) : null;
  const existing = target.prepare("SELECT * FROM submissions WHERE submission_id = ?").get(manifestSubmission.submissionId) as Record<string, unknown> | undefined;
  if (!existing) target.prepare("INSERT INTO submissions(submission_id, cartridge_id, version, status, submitted_by_user_id, submitted_by, reviewed_by_user_id, reviewed_by, created_at, reviewed_at, published_release_id, legacy_submission_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(manifestSubmission.submissionId, manifestSubmission.cartridgeId, manifestSubmission.version, manifestSubmission.targetStatus, row.submitted_by_user_id ?? null, row.submitted_by ?? "", row.reviewed_by_user_id ?? null, row.reviewed_by ?? "", manifestSubmission.createdAt, manifestSubmission.reviewedAt, publishedRelease, manifestSubmission.submissionId);
  else if (existing.cartridge_id !== manifestSubmission.cartridgeId || existing.version !== manifestSubmission.version || existing.status !== manifestSubmission.targetStatus || existing.legacy_submission_id !== manifestSubmission.submissionId) throw new MigrationError("target submission conflicts with source", "migration_target_conflict");
  for (const item of manifestSubmission.artifacts.filter((artifact) => artifact.mappingStatus === "mapped" && artifact.sha256 !== null && artifact.sizeBytes !== null)) {
    const stagingKey = copySubmissionFile(targetRoot, config, manifestSubmission.submissionId, item.architecture, item.sourceRef, item.sha256 as string, item.sizeBytes as number);
    const artifactIdValue = submissionArtifactId(manifestSubmission.submissionId, item.architecture);
    const existingArtifact = target.prepare("SELECT submission_id, architecture, staging_key, sha256, size_bytes FROM submission_artifacts WHERE submission_artifact_id = ?").get(artifactIdValue) as Record<string, unknown> | undefined;
    if (!existingArtifact) target.prepare("INSERT INTO submission_artifacts(submission_artifact_id, submission_id, architecture, source_filename, staging_key, sha256, size_bytes, media_type, validation_state, metadata_json, colophon_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'application/vnd.prg32.cartridge', 'validated', ?, NULL, ?)").run(artifactIdValue, manifestSubmission.submissionId, item.architecture, path.basename(item.sourceRef), stagingKey, item.sha256, item.sizeBytes, json(manifestSubmission.metadata), now());
    else if (existingArtifact.submission_id !== manifestSubmission.submissionId || existingArtifact.architecture !== item.architecture || existingArtifact.staging_key !== stagingKey || existingArtifact.sha256 !== item.sha256 || existingArtifact.size_bytes !== item.sizeBytes) throw new MigrationError("target submission artifact conflicts with source", "migration_target_conflict");
  }
  if (["approved", "rejected", "cancelled"].includes(manifestSubmission.targetStatus)) {
    const decision = manifestSubmission.targetStatus as "approved" | "rejected" | "cancelled";
    const decisionIdValue = decisionId(manifestSubmission.submissionId);
    const existingDecision = target.prepare("SELECT submission_id, decision, reviewer_user_id, created_at FROM review_decisions WHERE decision_id = ?").get(decisionIdValue) as Record<string, unknown> | undefined;
    if (!existingDecision) target.prepare("INSERT INTO review_decisions(decision_id, submission_id, decision, reviewer_user_id, reviewer_name, metadata_json, note, created_at) VALUES (?, ?, ?, ?, ?, ?, '', ?)").run(decisionIdValue, manifestSubmission.submissionId, decision, row.reviewed_by_user_id ?? null, row.reviewed_by ?? "", json({ source: "legacy-cartridge-submissions", legacyStatus: manifestSubmission.sourceStatus }), manifestSubmission.reviewedAt ?? manifestSubmission.createdAt);
    else if (existingDecision.submission_id !== manifestSubmission.submissionId || existingDecision.decision !== decision || existingDecision.reviewer_user_id !== (row.reviewed_by_user_id ?? null)) throw new MigrationError("target review decision conflicts with source", "migration_target_conflict");
  }
}

function ensureTelemetry(target: Database.Database, manifest: LegacyManifest, eventId: number, source: Database.Database, migrationIdValue: string): void {
  const event = manifest.telemetry.events.find((item) => item.eventId === eventId);
  if (!event) throw new MigrationError("telemetry event is absent from manifest", "migration_mapping_invalid");
  const row = source.prepare("SELECT * FROM download_events WHERE id = ?").get(eventId) as Record<string, unknown> | undefined;
  if (!row) throw new MigrationError("telemetry event disappeared from source snapshot", "migration_source_changed");
  if (event.mappingStatus === "mapped" && event.artifactLegacyId) {
    const targetArtifact = artifactId(event.artifactLegacyId);
    const targetRelease = releaseId(`${event.cartridgeId}@${event.version}`);
    const existing = target.prepare("SELECT cartridge_id, release_id, artifact_id, version, architecture, user_id, downloaded_at FROM download_events WHERE id = ?").get(event.eventId) as Record<string, unknown> | undefined;
    if (!existing) target.prepare("INSERT INTO download_events(id, cartridge_id, release_id, artifact_id, version, architecture, user_id, ip_hash, user_agent, downloaded_at, delivery_outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')").run(event.eventId, event.cartridgeId, targetRelease, targetArtifact, event.version, event.architecture, row.user_id ?? null, row.ip_hash ?? null, row.user_agent ?? null, event.downloadedAt);
    else if (existing.cartridge_id !== event.cartridgeId || existing.release_id !== targetRelease || existing.artifact_id !== targetArtifact || existing.version !== event.version || existing.architecture !== event.architecture || existing.user_id !== (row.user_id ?? null) || existing.downloaded_at !== event.downloadedAt) throw new MigrationError("target telemetry event conflicts with source", "migration_target_conflict");
    return;
  }
  const id = exceptionId(migrationIdValue, "download_event", String(event.eventId));
  const payload = json({ eventId: event.eventId, cartridgeId: event.cartridgeId, version: event.version, architecture: event.architecture, userId: event.userId, downloadedAt: event.downloadedAt, mappingStatus: event.mappingStatus });
  const existing = target.prepare("SELECT migration_id, payload_json FROM migration_exceptions WHERE exception_id = ?").get(id) as Record<string, unknown> | undefined;
  if (!existing) target.prepare("INSERT INTO migration_exceptions(exception_id, migration_id, entity_kind, legacy_id, reason_code, payload_json, created_at) VALUES (?, ?, 'download_event', ?, ?, ?, ?)").run(id, migrationIdValue, String(event.eventId), `download_${event.mappingStatus}`, payload, now());
  else if (existing.payload_json !== payload) throw new MigrationError("target migration exception conflicts with source", "migration_target_conflict");
}

function finalise(targetRoot: string, manifest: LegacyManifest, plan: MigrationPlan): void {
  const resource = openTargetStorage(targetRoot, "read-write");
  try {
    const sortedReleases = [...manifest.releases].sort((left, right) => `${left.publishedAt ?? left.updatedAt ?? DEFAULT_MIGRATION_TIMESTAMP}:${left.legacyId}`.localeCompare(`${right.publishedAt ?? right.updatedAt ?? DEFAULT_MIGRATION_TIMESTAMP}:${right.legacyId}`));
    const timestamp = now();
    resource.sqlite.transaction(() => {
      for (const [index, release] of sortedReleases.entries()) {
        const publishedAt = release.publishedAt ?? release.updatedAt ?? DEFAULT_MIGRATION_TIMESTAMP;
        resource.sqlite.prepare("UPDATE artifacts SET state = 'published' WHERE release_id = ? AND state = 'staged'").run(releaseId(release.legacyId));
        resource.sqlite.prepare("UPDATE releases SET state = 'published', published_at = ?, published_order = ? WHERE release_id = ? AND state = 'draft'").run(publishedAt, index + 1, releaseId(release.legacyId));
      }
      resource.sqlite.prepare("UPDATE publication_operation_items SET state = 'committed' WHERE operation_id = ?").run(plan.migrationId);
      resource.sqlite.prepare("UPDATE publication_operations SET state = 'completed', committed_at = COALESCE(committed_at, ?), completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE operation_id = ?").run(timestamp, timestamp, timestamp, plan.migrationId);
      const eventExists = resource.sqlite.prepare("SELECT 1 FROM publication_events WHERE operation_id = ? AND event_code = 'migration_completed'").get(plan.migrationId);
      if (!eventExists) resource.sqlite.prepare("INSERT INTO publication_events(operation_id, from_state, to_state, event_code, details_json, created_at) VALUES (?, 'prepared', 'completed', 'migration_completed', ?, ?)").run(plan.migrationId, json({ releaseCount: manifest.releases.length, artifactCount: manifest.artifacts.length }), timestamp);
      resource.sqlite.prepare("UPDATE storage_metadata SET updated_at = ? WHERE singleton_id = 1").run(timestamp);
    })();
  } finally {
    resource.close();
  }
}

function fault(config: MigrationConfig, point: MigrationConfig["faultAt"]): void {
  if (config.faultAt === point) throw new MigrationError("deterministic migration fault injected", "migration_fault_injected");
}

function journalError(journal: MigrationJournal, phase: MigrationPhase, error: unknown): MigrationJournal {
  const code = error instanceof MigrationError ? error.code : "migration_failed";
  return updateMigrationJournal(journal, {
    phase: "recovery_required",
    recoveryState: "resume_available",
    errors: [...journal.errors, { code, phase, message: code, at: now() }]
  });
}

function updateCompleted(journal: MigrationJournal, field: "completedTables" | "completedArtifacts" | "completedMedia" | "completedSubmissions" | "completedTelemetry", value: string | number, phase: MigrationPhase): MigrationJournal {
  const values = [...journal[field]];
  if (!values.includes(value)) values.push(value);
  return updateMigrationJournal(journal, { [field]: values, phase });
}

export function migrateLegacySnapshot(config: MigrationConfig): MigrationResult {
  if (config.authorization !== DISPOSABLE_MIGRATION_AUTHORIZATION) throw new MigrationError("explicit disposable authorization is required", "migration_authorization_required");
  const targetRoot = validateMigrationRoots(config);
  const manifest = loadMigrationManifest(config);
  validateMigrationManifest(manifest);
  verifyMigrationSource(config, manifest);
  const plan = planMigration(manifest);
  const existingJournal = readMigrationJournal(targetRoot, plan.migrationId);
  if (!existingJournal) {
    if (fs.existsSync(targetRoot) && fs.readdirSync(targetRoot).length > 0) throw new MigrationError("target root is not an empty disposable target or a known migration", "migration_target_not_empty");
    const initialized = initializeDisposableStorage(targetRoot);
    initialized.close();
    const journal = newMigrationJournal(plan.migrationId, manifest.manifestSha256, manifest.source.databaseFingerprint, manifest.source.storageInventoryFingerprint);
    writeMigrationJournal(targetRoot, journal);
    fault(config, "after-initialize");
  } else {
    if (existingJournal.manifestSha256 !== manifest.manifestSha256 || existingJournal.sourceDatabaseFingerprint !== manifest.source.databaseFingerprint || existingJournal.sourceStorageFingerprint !== manifest.source.storageInventoryFingerprint) throw new MigrationError("existing migration journal does not match the verified source", "migration_journal_conflict");
    if (existingJournal.completionState === "completed") {
      const verification = verifyMigratedTarget(config.snapshot, manifest, targetRoot, plan.migrationId);
      if (!verification.ok) throw new MigrationError("completed migration failed re-verification", "migration_completed_integrity_failed");
      return { ok: true, alreadyCompleted: true, migrationId: plan.migrationId, phase: "completed", targetRoot, plan, journal: existingJournal, verification };
    }
  }

  let journal = readMigrationJournal(targetRoot, plan.migrationId);
  if (!journal) throw new MigrationError("migration journal could not be initialized", "migration_journal_missing");
  const resource = openTargetStorage(targetRoot, "read-write");
  const source = openLegacySnapshot(config.snapshot);
  try {
    ensureOperation(resource.sqlite, plan);
    if (!journal.checkpoints.includes("operation-prepared")) {
      journal = appendCheckpoint(journal, "operation-prepared", "initialized");
      writeMigrationJournal(targetRoot, journal);
    }
    for (const table of plan.tables) {
      if (journal.completedTables.includes(table)) continue;
      copyCompatibleTable(source.sqlite, resource.sqlite, table);
      journal = updateCompleted(journal, "completedTables", table, "compatible-data");
      journal = appendCheckpoint(journal, `table:${table}`);
      writeMigrationJournal(targetRoot, journal);
      fault(config, "after-compatible-table");
    }
    createCartridgesAndReleases(resource.sqlite, manifest);
    for (const artifact of manifest.artifacts) {
      if (journal.completedArtifacts.includes(artifact.legacyId)) continue;
      ensureArtifact(targetRoot, config.snapshot, artifact, plan.migrationId);
      journal = updateCompleted(journal, "completedArtifacts", artifact.legacyId, "artifacts");
      journal = appendCheckpoint(journal, `artifact:${artifact.legacyId}`);
      writeMigrationJournal(targetRoot, journal);
      fault(config, "after-artifact");
    }
    for (const media of manifest.media) {
      if (journal.completedMedia.includes(media.legacyId)) continue;
      ensureMedia(targetRoot, config.snapshot, manifest.artifacts, media, plan.migrationId);
      journal = updateCompleted(journal, "completedMedia", media.legacyId, "media");
      journal = appendCheckpoint(journal, `media:${media.legacyId}`);
      writeMigrationJournal(targetRoot, journal);
      fault(config, "after-media");
    }
    for (const siteAsset of manifest.sourceFiles.filter((file) => file.kind === "site_asset")) {
      const key = `site:${siteAsset.sourceRef}`;
      if (journal.completedMedia.includes(key)) continue;
      ensureSiteAsset(targetRoot, config.snapshot, siteAsset, plan.migrationId);
      journal = updateCompleted(journal, "completedMedia", key, "media");
      journal = appendCheckpoint(journal, key);
      writeMigrationJournal(targetRoot, journal);
      fault(config, "after-media");
    }
    for (const submission of manifest.submissions) {
      if (journal.completedSubmissions.includes(submission.submissionId)) continue;
      ensureSubmission(resource.sqlite, targetRoot, config.snapshot, submission, source.sqlite);
      journal = updateCompleted(journal, "completedSubmissions", submission.submissionId, "submissions");
      journal = appendCheckpoint(journal, `submission:${submission.submissionId}`);
      writeMigrationJournal(targetRoot, journal);
      fault(config, "after-submission");
    }
    for (const event of manifest.telemetry.events) {
      if (journal.completedTelemetry.includes(event.eventId)) continue;
      ensureTelemetry(resource.sqlite, manifest, event.eventId, source.sqlite, plan.migrationId);
      journal = updateCompleted(journal, "completedTelemetry", event.eventId, "telemetry");
      journal = appendCheckpoint(journal, `telemetry:${event.eventId}`);
      writeMigrationJournal(targetRoot, journal);
      fault(config, "after-telemetry");
    }
    journal = appendCheckpoint(journal, "objects-and-database-ready", "finalization");
    writeMigrationJournal(targetRoot, journal);
    fault(config, "before-finalization");
    finalise(targetRoot, manifest, plan);
    fault(config, "after-finalization");
    journal = appendCheckpoint(journal, "publication-finalized", "verifying");
    writeMigrationJournal(targetRoot, journal);
    fault(config, "before-verification");
    const verification = verifyMigratedTarget(config.snapshot, manifest, targetRoot, plan.migrationId);
    if (!verification.ok) throw new MigrationError("target integrity or differential verification failed", "migration_verification_failed");
    journal = updateMigrationJournal(journal, { phase: "completed", recoveryState: "none", completionState: "completed", checkpoints: [...new Set([...journal.checkpoints, "target-verified", "migration-completed"])] });
    writeMigrationJournal(targetRoot, journal);
    return { ok: true, alreadyCompleted: false, migrationId: plan.migrationId, phase: "completed", targetRoot, plan, journal, verification };
  } catch (error) {
    journal = journalError(journal, journal.phase, error);
    writeMigrationJournal(targetRoot, journal);
    throw error;
  } finally {
    source.close();
    resource.close();
  }
}

export function verifyMigration(config: MigrationConfig): MigrationResult {
  if (config.authorization !== DISPOSABLE_MIGRATION_AUTHORIZATION) throw new MigrationError("explicit disposable authorization is required", "migration_authorization_required");
  const targetRoot = validateMigrationRoots(config);
  const manifest = loadMigrationManifest(config);
  validateMigrationManifest(manifest);
  verifyMigrationSource(config, manifest);
  const plan = planMigration(manifest);
  const journal = readMigrationJournal(targetRoot, plan.migrationId);
  if (!journal) throw new MigrationError("migration journal is missing", "migration_journal_missing");
  const verification = verifyMigratedTarget(config.snapshot, manifest, targetRoot, plan.migrationId);
  return { ok: verification.ok, alreadyCompleted: journal.completionState === "completed", migrationId: plan.migrationId, phase: journal.phase, targetRoot, plan, journal, verification };
}

export function migrationStatus(targetRootValue: string, migrationIdValue: string): MigrationJournal | null {
  const targetRoot = path.resolve(targetRootValue);
  if (!isDisposablePath(targetRoot) || targetRoot === path.resolve(process.cwd()) || isInside(process.cwd(), targetRoot)) throw new MigrationError("target root is not a disposable path", "migration_target_forbidden");
  return readMigrationJournal(targetRoot, migrationIdValue);
}

export function disposeMigrationTarget(targetRootValue: string, migrationIdValue: string, authorization: string): void {
  if (authorization !== DISPOSABLE_MIGRATION_AUTHORIZATION) throw new MigrationError("explicit disposable authorization is required", "migration_authorization_required");
  const targetRoot = path.resolve(targetRootValue);
  if (!isDisposablePath(targetRoot) || targetRoot === path.resolve(process.cwd()) || isInside(process.cwd(), targetRoot)) throw new MigrationError("target root is not a disposable path", "migration_target_forbidden");
  const journal = readMigrationJournal(targetRoot, migrationIdValue);
  if (!journal) throw new MigrationError("migration journal is missing", "migration_journal_missing");
  if (journal.completionState === "completed") throw new MigrationError("completed migration targets require explicit external retention policy", "migration_disposal_completed_forbidden");
  const marker = path.join(targetRoot, ".prg32-storage-v2");
  if (!fs.existsSync(marker)) throw new MigrationError("target is not an initialized storage-v2 root", "migration_target_invalid");
  writeAtomic(path.join(targetRoot, "journal", "migrations", `${migrationIdValue}.disposal-requested.json`), `${canonicalJson({ migrationId: migrationIdValue, requestedAt: now(), state: "disposal-authorized" })}\n`);
  fs.rmSync(targetRoot, { recursive: true, force: true });
}
