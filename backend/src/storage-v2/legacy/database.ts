import crypto from "node:crypto";
import fs from "node:fs";

import Database from "better-sqlite3";

import {
  hashFile,
  parseSnapshotMarker,
  relativeSourceRef,
  resolveLegacySnapshotConfig,
  type HashedFile
} from "./filesystem.js";
import type {
  LegacyDatabaseInspection,
  LegacySnapshotConfig,
  OpenLegacySnapshot
} from "./types.js";

export class LegacyDatabaseError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, code = "legacy_database_invalid", details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegacyDatabaseError";
    this.code = code;
    this.details = details;
  }
}

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ["id", "username", "email", "role"],
  groups: ["id", "name"],
  user_groups: ["user_id", "group_id"],
  api_tokens: ["id", "user_id", "token_hash"],
  registration_tokens: ["id", "email", "token_hash"],
  store_settings: ["key", "value"],
  scores: ["id", "game", "player", "score", "created_at"],
  runs: ["run_id", "board_id", "target", "started_at"],
  samples: ["id", "run_id", "frame", "timestamp_ms", "frame_us"],
  download_events: ["id", "game_id", "version", "architecture", "downloaded_at"],
  cartridge_submissions: ["id", "game_id", "version", "status", "metadata_json", "architectures_json", "created_at"]
};

const REQUIRED_TABLES = Object.keys(REQUIRED_COLUMNS).sort();

function tableNames(sqlite: Database.Database): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
}

function schemaFingerprint(sqlite: Database.Database): string {
  const rows = sqlite.prepare(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name, tbl_name`
  ).all() as Array<Record<string, unknown>>;
  return sha256String(JSON.stringify(rows));
}

function sha256String(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function databaseFiles(paths: { readonly root: string; readonly databasePath: string }): readonly HashedFile[] {
  const candidates = [paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`];
  const files: HashedFile[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stats = fs.lstatSync(candidate);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new LegacyDatabaseError("database component is not a regular file", "legacy_database_component_invalid");
    files.push(hashFile({ sourceRef: relativeSourceRef(paths.root, candidate), absolutePath: candidate }));
  }
  return files;
}

function databaseFingerprint(paths: { readonly root: string; readonly databasePath: string }): string {
  const files = databaseFiles(paths).map((file) => ({ sourceRef: file.sourceRef, sizeBytes: file.sizeBytes, sha256: file.sha256 }));
  return sha256String(JSON.stringify(files));
}

function columns(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function rowCounts(sqlite: Database.Database, tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = Number((sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count);
  return counts;
}

function inspectDatabase(sqlite: Database.Database, paths: { readonly root: string; readonly databasePath: string }): LegacyDatabaseInspection {
  const tables = tableNames(sqlite);
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.includes(table));
  if (missingTables.length > 0) {
    throw new LegacyDatabaseError("legacy database is missing required tables", "legacy_schema_incompatible", { missingTables });
  }
  const missingColumns: Record<string, string[]> = {};
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(columns(sqlite, table));
    const missing = required.filter((column) => !present.has(column));
    if (missing.length > 0) missingColumns[table] = missing;
  }
  if (Object.keys(missingColumns).length > 0) {
    throw new LegacyDatabaseError("legacy database has incompatible table columns", "legacy_schema_incompatible", { missingColumns });
  }
  const foreignKeyViolations = sqlite.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  const files = databaseFiles(paths);
  return {
    schemaFingerprint: schemaFingerprint(sqlite),
    databaseFingerprint: databaseFingerprint(paths),
    tables,
    rowCounts: rowCounts(sqlite, tables),
    foreignKeyViolations,
    walPresent: files.some((file) => file.sourceRef.endsWith("-wal")),
    shmPresent: files.some((file) => file.sourceRef.endsWith("-shm"))
  };
}

export function openLegacySnapshot(config: LegacySnapshotConfig): OpenLegacySnapshot {
  const paths = resolveLegacySnapshotConfig(config);
  const marker = parseSnapshotMarker(paths.preparedMarkerPath);
  const markerPaths: Readonly<Record<string, string>> = {
    database: relativeSourceRef(paths.root, paths.databasePath),
    catalog: relativeSourceRef(paths.root, paths.catalogPath),
    dataRoot: relativeSourceRef(paths.root, paths.dataRoot),
    cartridgeRoot: relativeSourceRef(paths.root, paths.cartridgeRoot)
  };
  for (const [key, expected] of Object.entries(markerPaths)) {
    if (marker[key] !== expected) throw new LegacyDatabaseError(`snapshot marker ${key} does not match explicit configuration`, "snapshot_marker_mismatch");
  }
  let sqlite: Database.Database;
  try {
    sqlite = new Database(paths.databasePath, { readonly: true, fileMustExist: true, timeout: 5000 });
    sqlite.pragma("query_only = ON");
    sqlite.prepare("SELECT 1").get();
  } catch (error) {
    throw new LegacyDatabaseError("legacy database could not be opened read-only", "legacy_database_open_failed", {}, { cause: error });
  }
  try {
    const database = inspectDatabase(sqlite, paths);
    return {
      paths,
      sqlite,
      marker,
      database,
      close: () => sqlite.close()
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export function assertDatabaseUnchanged(snapshot: OpenLegacySnapshot, initialFingerprint: string): void {
  const current = databaseFingerprint(snapshot.paths);
  if (current !== initialFingerprint) throw new LegacyDatabaseError("legacy database changed during inventory", "inconsistent_snapshot", { initialFingerprint, currentFingerprint: current });
}

export function getRequiredTables(): readonly string[] {
  return REQUIRED_TABLES;
}
