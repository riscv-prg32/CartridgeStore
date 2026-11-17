import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import Database from "better-sqlite3";

import {
  COMPATIBLE_SCHEMA_SQL,
  TARGET_SCHEMA_SQL,
  TARGET_TABLES,
  TARGET_VERSION_TUPLE,
  COMPATIBLE_TABLES
} from "./schema.js";
import {
  TARGET_APPLICATION,
  type StorageDatabase,
  type StoragePaths
} from "./types.js";
import { applyApplicationMigrations } from "../db/application-migrations.js";

const TARGET_ROOT_MARKER = ".prg32-storage-v2";
const MIGRATION_ID = "storage-v2-schema-foundation";

export class StorageDatabaseError extends Error {
  readonly code: string;

  constructor(message: string, code = "storage_database_invalid", options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageDatabaseError";
    this.code = code;
  }
}

function now(): string {
  return new Date().toISOString();
}

function requirePath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StorageDatabaseError("disposable storage root is required", "storage_root_required");
  }
  const raw = value.trim();
  if (raw.split(/[\\/]/u).includes("..")) {
    throw new StorageDatabaseError("disposable storage root may not contain parent traversal", "storage_root_unsafe");
  }
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) {
    throw new StorageDatabaseError("filesystem root is not an allowed storage root", "storage_root_unsafe");
  }
  return resolved;
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function forbiddenRoots(): readonly string[] {
  const values = [
    process.cwd(),
    process.env.PRG32_DATA_ROOT,
    process.env.PRG32_STORE_DATA,
    process.env.PRG32_BACKEND_STORE_DATA,
    process.env.PRG32_BACKEND_DB,
    process.env.PRG32_STORE_DB
  ];
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => path.resolve(value));
}

function assertDisposableRoot(root: string): void {
  for (const forbidden of forbiddenRoots()) {
    if (path.resolve(root) === forbidden) {
      throw new StorageDatabaseError("storage root overlaps an operational or repository root", "storage_root_forbidden");
    }
  }
  if (fs.existsSync(root)) {
    const stats = fs.lstatSync(root);
    if (stats.isSymbolicLink()) throw new StorageDatabaseError("storage root may not be a symlink", "storage_root_symlink");
    if (!stats.isDirectory()) throw new StorageDatabaseError("storage root must be a directory", "storage_root_invalid");
    if (fs.readdirSync(root).length > 0) {
      throw new StorageDatabaseError("storage root must be empty before initialization", "storage_root_not_empty");
    }
  } else {
    const parent = path.dirname(root);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new StorageDatabaseError("storage root parent directory is unavailable", "storage_root_parent_invalid");
    }
    fs.mkdirSync(root, { mode: 0o700 });
  }
  const real = fs.realpathSync(root);
  for (const forbidden of forbiddenRoots()) {
    if (real === forbidden || isSameOrInside(real, forbidden)) {
      if (real === forbidden) {
        throw new StorageDatabaseError("storage root overlaps an operational or repository root", "storage_root_forbidden");
      }
    }
  }
  fs.chmodSync(root, 0o700);
}

function ensureDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new StorageDatabaseError("storage layout contains an unsafe path", "storage_layout_unsafe");
    }
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
}

function layout(root: string): StoragePaths {
  const storageRoot = path.join(root, "storage");
  const objectRoot = path.join(storageRoot, "objects");
  const journalRoot = path.join(root, "journal");
  const paths: StoragePaths = {
    root,
    databasePath: path.join(root, "store.sqlite"),
    storageRoot,
    objectRoot,
    artifactRoot: path.join(objectRoot, "artifacts"),
    mediaRoot: path.join(objectRoot, "media"),
    siteAssetRoot: path.join(objectRoot, "site-assets"),
    objectTempRoot: path.join(objectRoot, ".tmp"),
    stagingRoot: path.join(storageRoot, "staging"),
    submissionStagingRoot: path.join(storageRoot, "staging", "submissions"),
    operationStagingRoot: path.join(storageRoot, "staging", "operations"),
    quarantineRoot: path.join(storageRoot, "quarantine"),
    journalRoot,
    publicationJournalRoot: path.join(journalRoot, "publications"),
    backupRoot: path.join(root, "backups"),
    compatibilityRoot: path.join(root, "compatibility")
  };
  return paths;
}

function initializeLayout(paths: StoragePaths): void {
  [
    paths.storageRoot,
    paths.objectRoot,
    paths.artifactRoot,
    paths.mediaRoot,
    paths.siteAssetRoot,
    paths.objectTempRoot,
    paths.stagingRoot,
    paths.submissionStagingRoot,
    paths.operationStagingRoot,
    paths.quarantineRoot,
    paths.journalRoot,
    paths.publicationJournalRoot,
    paths.backupRoot,
    paths.compatibilityRoot
  ].forEach(ensureDirectory);
}

function tableNames(sqlite: Database.Database): Set<string> {
  return new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
  );
}

function assertRequiredTables(sqlite: Database.Database): void {
  const present = tableNames(sqlite);
  const missing = [...COMPATIBLE_TABLES, ...TARGET_TABLES].filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new StorageDatabaseError(`target schema is missing required tables: ${missing.join(", ")}`, "storage_schema_incomplete");
  }
}

function assertVersionTuple(sqlite: Database.Database): void {
  const row = sqlite.prepare("SELECT * FROM storage_metadata WHERE singleton_id = 1").get() as Record<string, unknown> | undefined;
  if (!row) throw new StorageDatabaseError("target storage metadata is missing", "storage_metadata_missing");
  if (
    row.application !== TARGET_APPLICATION ||
    row.schema_version !== TARGET_VERSION_TUPLE.schemaVersion ||
    row.storage_layout_version !== TARGET_VERSION_TUPLE.storageLayoutVersion ||
    row.publication_journal_version !== TARGET_VERSION_TUPLE.publicationJournalVersion ||
    row.backup_format_version !== TARGET_VERSION_TUPLE.backupFormatVersion ||
    row.state !== "ready"
  ) {
    throw new StorageDatabaseError("target storage version or initialization state is incompatible", "storage_version_incompatible");
  }
}

export function assertCompatibleStorage(sqlite: Database.Database): void {
  sqlite.pragma("foreign_keys = ON");
  assertRequiredTables(sqlite);
  assertVersionTuple(sqlite);
}

function schemaChecksum(): string {
  return crypto.createHash("sha256").update(`${COMPATIBLE_SCHEMA_SQL}\n${TARGET_SCHEMA_SQL}`).digest("hex");
}

function openSqlite(databasePath: string, readOnly: boolean): Database.Database {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(databasePath, { readonly: readOnly, fileMustExist: true, timeout: 5000 });
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    if (readOnly) sqlite.pragma("query_only = ON");
    sqlite.prepare("SELECT 1").get();
  } catch (error) {
    throw new StorageDatabaseError("target SQLite database could not be opened", "storage_database_open_failed", { cause: error });
  }
  return sqlite;
}

function initializeStorage(rootValue: string, assertRoot: (root: string) => void): StorageDatabase {
  const root = requirePath(rootValue);
  assertRoot(root);
  const paths = layout(root);
  initializeLayout(paths);
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(paths.databasePath, { timeout: 5000 });
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(COMPATIBLE_SCHEMA_SQL);
      sqlite.exec(TARGET_SCHEMA_SQL);
      applyApplicationMigrations(sqlite);
      const timestamp = now();
      sqlite.prepare(
        `INSERT INTO storage_metadata(singleton_id, application, schema_version, storage_layout_version,
          publication_journal_version, backup_format_version, state, initialized_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, 'ready', ?, ?)`
      ).run(
        TARGET_APPLICATION,
        TARGET_VERSION_TUPLE.schemaVersion,
        TARGET_VERSION_TUPLE.storageLayoutVersion,
        TARGET_VERSION_TUPLE.publicationJournalVersion,
        TARGET_VERSION_TUPLE.backupFormatVersion,
        timestamp,
        timestamp
      );
      sqlite.prepare(
        `INSERT INTO schema_migrations(migration_id, component, version, state, started_at, completed_at, checksum)
         VALUES (?, 'storage-v2', ?, 'applied', ?, ?, ?)`
        ).run(MIGRATION_ID, TARGET_VERSION_TUPLE.schemaVersion, timestamp, timestamp, schemaChecksum());
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
    fs.chmodSync(paths.databasePath, 0o600);
    fs.writeFileSync(path.join(root, TARGET_ROOT_MARKER), `${TARGET_APPLICATION}\n`, { encoding: "utf8", mode: 0o600 });
    assertCompatibleStorage(sqlite);
    return { sqlite, paths, readOnly: false, close: () => sqlite?.close() };
  } catch (error) {
    sqlite?.close();
    if (error instanceof StorageDatabaseError) throw error;
    throw new StorageDatabaseError("target storage initialization failed", "storage_initialization_failed", { cause: error });
  }
}

export function initializeDisposableStorage(rootValue: string): StorageDatabase {
  return initializeStorage(rootValue, assertDisposableRoot);
}

/** Explicit operator-authorized bootstrap for a new canonical operational root. */
export function initializeOperationalStorage(rootValue: string, authorization: string): StorageDatabase {
  if (authorization.trim().length < 32) {
    throw new StorageDatabaseError("operational bootstrap authorization is invalid", "storage_bootstrap_unauthorized");
  }
  const root = requirePath(rootValue);
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    throw new StorageDatabaseError("operational storage bootstrap requires an empty root", "storage_root_not_empty");
  }
  return initializeStorage(root, (candidate) => {
    if (fs.existsSync(candidate)) {
      const stats = fs.lstatSync(candidate);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new StorageDatabaseError("operational storage root is unsafe", "storage_root_unsafe");
      fs.chmodSync(candidate, 0o700);
    } else {
      const parent = path.dirname(candidate);
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new StorageDatabaseError("storage root parent directory is unavailable", "storage_root_parent_invalid");
      fs.mkdirSync(candidate, { mode: 0o700 });
    }
  });
}

export function openTargetStorage(rootValue: string, mode: "read-only" | "read-write" = "read-only"): StorageDatabase {
  const root = requirePath(rootValue);
  if (!fs.existsSync(root)) throw new StorageDatabaseError("target storage root does not exist", "storage_root_missing");
  const rootStats = fs.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new StorageDatabaseError("target storage root is unsafe", "storage_root_unsafe");
  const paths = layout(root);
  for (const directory of [paths.storageRoot, paths.objectRoot, paths.artifactRoot, paths.mediaRoot, paths.siteAssetRoot, paths.stagingRoot, paths.journalRoot]) {
    if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) {
      throw new StorageDatabaseError("target storage layout is incomplete or unsafe", "storage_layout_incomplete");
    }
  }
  if (!fs.existsSync(paths.databasePath) || fs.lstatSync(paths.databasePath).isSymbolicLink()) {
    throw new StorageDatabaseError("target storage database is missing or unsafe", "storage_database_missing");
  }
  const sqlite = openSqlite(paths.databasePath, mode === "read-only");
  try {
    if (mode === "read-write") applyApplicationMigrations(sqlite);
    assertCompatibleStorage(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return { sqlite, paths, readOnly: mode === "read-only", close: () => sqlite.close() };
}

export function isDisposablePath(rootValue: string): boolean {
  try {
    const root = requirePath(rootValue);
    return forbiddenRoots().every((forbidden) => root !== forbidden);
  } catch {
    return false;
  }
}

export { TARGET_ROOT_MARKER };
