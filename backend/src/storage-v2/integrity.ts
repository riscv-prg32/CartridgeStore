import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { ObjectStore, expectedStorageKey } from "./objects.js";
import { TARGET_TABLES, COMPATIBLE_TABLES, TARGET_VERSION_TUPLE } from "./schema.js";
import type { IntegrityFinding, IntegrityReport, ObjectKind, StoragePaths } from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function finding(
  code: string,
  severity: IntegrityFinding["severity"],
  message: string,
  options: Pick<IntegrityFinding, "objectId" | "relationship"> = {}
): IntegrityFinding {
  return { code, severity, message, ...options };
}

function push(findings: IntegrityFinding[], item: IntegrityFinding): void {
  findings.push(item);
}

function tableSet(sqlite: Database.Database): Set<string> {
  return new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
  );
}

function walkFiles(root: string, findings: IntegrityFinding[], relative = ""): string[] {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    const key = path.posix.join(relative.replaceAll(path.sep, "/"), entry.name);
    if (entry.isSymbolicLink()) {
      push(findings, finding("symlinked_object", "error", `object tree contains a symlink at ${key}`));
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolute, findings, key));
    } else if (entry.isFile()) {
      files.push(key);
    } else {
      push(findings, finding("unexpected_object_type", "error", `object tree contains a non-regular entry at ${key}`));
    }
  }
  return files;
}

function addSchemaFindings(sqlite: Database.Database, findings: IntegrityFinding[]): void {
  const present = tableSet(sqlite);
  for (const table of [...COMPATIBLE_TABLES, ...TARGET_TABLES]) {
    if (!present.has(table)) push(findings, finding("schema_table_missing", "error", `required table ${table} is missing`));
  }
  if (!present.has("storage_metadata")) return;
  const row = sqlite.prepare("SELECT * FROM storage_metadata WHERE singleton_id = 1").get() as Record<string, unknown> | undefined;
  if (!row) {
    push(findings, finding("schema_metadata_missing", "error", "storage metadata singleton is missing"));
    return;
  }
  const values = [
    ["schema_version", TARGET_VERSION_TUPLE.schemaVersion],
    ["storage_layout_version", TARGET_VERSION_TUPLE.storageLayoutVersion],
    ["publication_journal_version", TARGET_VERSION_TUPLE.publicationJournalVersion],
    ["backup_format_version", TARGET_VERSION_TUPLE.backupFormatVersion]
  ] as const;
  for (const [key, expected] of values) {
    if (row[key] !== expected) push(findings, finding("schema_version_incompatible", "error", `${key} is incompatible`));
  }
  if (row.state !== "ready") push(findings, finding("schema_initialization_incomplete", "error", "storage metadata is not ready"));
}

function auditObjects(sqlite: Database.Database, paths: StoragePaths, findings: IntegrityFinding[]): void {
  const store = new ObjectStore(sqlite, paths);
  const rows = sqlite.prepare("SELECT * FROM storage_objects ORDER BY object_id").all() as Array<Record<string, unknown>>;
  const expectedFiles = new Set<string>();
  for (const row of rows) {
    const objectId = String(row.object_id);
    const objectKind = String(row.object_kind) as ObjectKind;
    const storageKey = String(row.storage_key);
    try {
      expectedFiles.add(storageKey);
      if (expectedStorageKey(objectKind, objectId, String(row.media_type)) !== storageKey) {
        push(findings, finding("invalid_storage_key", "error", "storage key is not derived from object identity", { objectId }));
        continue;
      }
    } catch {
      push(findings, finding("invalid_storage_metadata", "error", "object kind, identifier, or media type is invalid", { objectId }));
      continue;
    }
    const verification = store.verify(objectId);
    if (!verification.ok) {
      push(findings, finding(`object_${verification.code}`, "error", verification.message, { objectId }));
    }
  }

  const roots = [
    [paths.artifactRoot, "artifacts"],
    [paths.mediaRoot, "media"],
    [paths.siteAssetRoot, "site-assets"]
  ] as const;
  for (const [root, folder] of roots) {
    for (const file of walkFiles(root, findings)) {
      const storageKey = `storage/objects/${folder}/${file}`;
      if (!expectedFiles.has(storageKey)) push(findings, finding("orphaned_object_file", "warning", `object file is not referenced by storage_objects: ${storageKey}`));
    }
  }
  for (const file of walkFiles(paths.objectTempRoot, findings)) {
    push(findings, finding("temporary_object_leftover", "warning", `temporary object file remains under the object temp directory: ${file}`));
  }
}

function auditRelationships(sqlite: Database.Database, findings: IntegrityFinding[]): void {
  const artifactRows = sqlite.prepare(
    `SELECT a.artifact_id, a.object_id, a.state AS artifact_state, so.object_kind, so.state AS object_state
     FROM artifacts a LEFT JOIN storage_objects so ON so.object_id = a.object_id`
  ).all() as Array<Record<string, unknown>>;
  for (const row of artifactRows) {
    if (row.object_kind !== "artifact") push(findings, finding("artifact_object_kind_invalid", "error", "artifact relationship does not reference an artifact object", { objectId: String(row.object_id), relationship: `artifact:${String(row.artifact_id)}` }));
    if (row.artifact_state === "published" && row.object_state !== "available") push(findings, finding("published_artifact_unavailable", "error", "published artifact does not reference an available object", { objectId: String(row.object_id), relationship: `artifact:${String(row.artifact_id)}` }));
  }
  const mediaRows = sqlite.prepare(
    `SELECT media_id, object_id, object_kind FROM media LEFT JOIN storage_objects USING (object_id)`
  ).all() as Array<Record<string, unknown>>;
  for (const row of mediaRows) {
    if (row.object_kind !== "media") push(findings, finding("media_object_kind_invalid", "error", "media relationship does not reference a media object", { objectId: String(row.object_id), relationship: `media:${String(row.media_id)}` }));
  }
  const assetRows = sqlite.prepare(
    `SELECT asset_id, object_id, object_kind FROM site_assets LEFT JOIN storage_objects USING (object_id)`
  ).all() as Array<Record<string, unknown>>;
  for (const row of assetRows) {
    if (row.object_kind !== "site_asset") push(findings, finding("site_asset_object_kind_invalid", "error", "site asset relationship does not reference a site asset object", { objectId: String(row.object_id), relationship: `site_asset:${String(row.asset_id)}` }));
  }
  const itemRows = sqlite.prepare(
    `SELECT operation_item_id, item_kind, target_role, expected_object_id, object_kind
     FROM publication_operation_items LEFT JOIN storage_objects ON storage_objects.object_id = expected_object_id`
  ).all() as Array<Record<string, unknown>>;
  for (const row of itemRows) {
    if (row.object_kind !== row.item_kind) push(findings, finding("publication_object_kind_invalid", "error", "publication operation item kind does not match object kind", { objectId: String(row.expected_object_id), relationship: `publication_item:${String(row.operation_item_id)}` }));
  }
}

export function auditStorage(sqlite: Database.Database, paths: StoragePaths): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  addSchemaFindings(sqlite, findings);
  try {
    const foreignKeys = sqlite.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    for (const violation of foreignKeys) {
      const table = typeof violation.table === "string" ? violation.table : "unknown table";
      push(findings, finding("foreign_key_violation", "error", `foreign-key violation in ${table}`));
    }
  } catch {
    push(findings, finding("foreign_key_check_failed", "error", "foreign-key integrity could not be checked"));
  }
  const present = tableSet(sqlite);
  if (present.has("storage_objects")) auditObjects(sqlite, paths, findings);
  if (present.has("artifacts") && present.has("media") && present.has("site_assets") && present.has("publication_operation_items")) auditRelationships(sqlite, findings);
  const counts: Record<string, number> = {};
  for (const item of findings) counts[item.code] = (counts[item.code] ?? 0) + 1;
  return { ok: findings.every((item) => item.severity !== "error"), checkedAt: now(), findings, counts };
}
