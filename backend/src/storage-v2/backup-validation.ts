import crypto from "node:crypto";
import fs from "node:fs";

import type Database from "better-sqlite3";

import { BackupError } from "../backup/format.js";
import { inspectSchema } from "../db/schema-inspection.js";
import {
  COMPATIBLE_TABLES,
  TARGET_TABLES,
  TARGET_VERSION_TUPLE,
} from "./schema.js";

/** Shared streaming chunk size for backup file reads. */
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
const INCOMPLETE_PUBLICATION_STATES = new Set([
  "prepared",
  "objects_staged",
  "objects_verified",
  "database_committed",
  "cleanup_pending",
  "recovery_required",
  "compensating",
]);

/** Returns the streamed size and SHA-256 digest of a regular file. */
export function sha256File(
  filePath: string,
): { readonly sizeBytes: number; readonly sha256: string } {
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new BackupError(
      "canonical backup requires regular files",
      "canonical_backup_file_invalid",
    );
  }
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(BACKUP_CHUNK_BYTES);
  let sizeBytes = 0;
  try {
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      sizeBytes += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

/** Serializes JSON values with stable object-key ordering. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`,
    )
    .join(",")}}`;
}

/** Calculates the SHA-256 digest of UTF-8 text. */
export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Returns the canonical schema fingerprint and table inventory. */
export function schemaFingerprint(
  sqlite: Database.Database,
): { readonly fingerprint: string; readonly tables: readonly string[] } {
  const snapshot = inspectSchema(sqlite);
  return {
    fingerprint: hashText(canonicalJson(snapshot)),
    tables: snapshot.tables.map((table) => table.name).sort(),
  };
}

function tableNames(sqlite: Database.Database): readonly string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
          "AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** Verifies the canonical SQLite integrity and version contract. */
export function assertDatabase(
  sqlite: Database.Database,
  allowRecoveryState = false,
): void {
  const integrity = sqlite.prepare("PRAGMA integrity_check").get() as {
    integrity_check?: unknown;
  };
  if (integrity.integrity_check !== "ok") {
    throw new BackupError(
      "canonical SQLite integrity check failed",
      "canonical_backup_database_integrity",
    );
  }
  if (sqlite.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new BackupError(
      "canonical SQLite foreign-key check failed",
      "canonical_backup_database_foreign_keys",
    );
  }
  const names = new Set(tableNames(sqlite));
  for (const table of [...COMPATIBLE_TABLES, ...TARGET_TABLES]) {
    if (!names.has(table)) {
      throw new BackupError(
        "canonical SQLite schema is incomplete",
        "canonical_backup_schema_incompatible",
      );
    }
  }
  const row = sqlite
    .prepare("SELECT * FROM storage_metadata WHERE singleton_id = 1")
    .get() as Record<string, unknown> | undefined;
  if (
    !row ||
    row.application !== "prg32-cartridge-store" ||
    row.schema_version !== TARGET_VERSION_TUPLE.schemaVersion ||
    row.storage_layout_version !== TARGET_VERSION_TUPLE.storageLayoutVersion ||
    row.publication_journal_version !==
      TARGET_VERSION_TUPLE.publicationJournalVersion ||
    row.backup_format_version !== TARGET_VERSION_TUPLE.backupFormatVersion ||
    (!allowRecoveryState && row.state !== "ready") ||
    (allowRecoveryState &&
      !["ready", "recovery_required"].includes(String(row.state)))
  ) {
    throw new BackupError(
      "canonical SQLite version tuple or state is incompatible",
      "canonical_backup_version_incompatible",
    );
  }
}

/** Reports whether canonical storage contains unfinished recovery state. */
export function recoveryRequired(sqlite: Database.Database): boolean {
  const metadata = sqlite
    .prepare("SELECT state FROM storage_metadata WHERE singleton_id = 1")
    .get() as { state?: string } | undefined;
  const publication = sqlite
    .prepare("SELECT state FROM publication_operations")
    .all() as Array<{ state: string }>;
  const migration = sqlite
    .prepare("SELECT state FROM schema_migrations")
    .all() as Array<{ state: string }>;
  return (
    metadata?.state === "recovery_required" ||
    publication.some((row) => INCOMPLETE_PUBLICATION_STATES.has(row.state)) ||
    migration.some((row) => row.state === "running")
  );
}
