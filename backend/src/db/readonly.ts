import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { applyFederationMigrations, FederationMigrationError } from "./federation-migrations.js";
import { applyApplicationMigrations } from "./application-migrations.js";
import { schema } from "./schema.js";

export type ReadonlyDrizzleDatabase = BetterSQLite3Database<typeof schema>;

export interface ReadonlyDatabase {
  readonly db: ReadonlyDrizzleDatabase;
  readonly sqlite: Database.Database;
  close(): void;
}

export class ReadonlyDatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReadonlyDatabaseError";
  }
}

function ensureNotSqliteUri(value: string, label: string): void {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("file:") || normalized.includes("?mode=") || normalized.includes("&mode=")) {
    throw new ReadonlyDatabaseError(`${label} must be a filesystem path, not a SQLite URI`);
  }
}

function lstatPath(value: string, label: string): fs.Stats {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    throw new ReadonlyDatabaseError(`${label} is unavailable`, { cause: error });
  }
}

function optionalLstatPath(value: string, label: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new ReadonlyDatabaseError(`${label} could not be inspected`, { cause: error });
  }
}

function rejectSymlinkComponentsWithin(rootValue: string, value: string, label: string): void {
  const root = path.resolve(rootValue);
  const resolved = path.resolve(value);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = lstatPath(current, label);
    if (stats.isSymbolicLink()) {
      throw new ReadonlyDatabaseError(`${label} may not contain symlink components`);
    }
  }
}

function identity(stats: fs.Stats, label: string): string {
  if (!Number.isSafeInteger(stats.dev) || !Number.isSafeInteger(stats.ino)) {
    throw new ReadonlyDatabaseError(`${label} filesystem identity is unavailable`);
  }
  return `${stats.dev}:${stats.ino}`;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateAuthWriterTarget(config: BackendConfig): { writerStats: fs.Stats; operationalStats: fs.Stats } {
  if (!config.authWriteDatabasePath || !config.authDisposableRoot) {
    throw new ReadonlyDatabaseError("authentication write isolation is not configured");
  }
  ensureNotSqliteUri(config.authWriteDatabasePath, "auth write database");
  ensureNotSqliteUri(config.databasePath, "operational database");

  const rootStats = lstatPath(config.authDisposableRoot, "auth disposable root");
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new ReadonlyDatabaseError("auth disposable root must be a regular directory without symlink indirection");
  }
  const rootReal = fs.realpathSync(config.authDisposableRoot);

  const operationalStats = lstatPath(config.databasePath, "operational database");
  if (operationalStats.isSymbolicLink()) {
    const operationalReal = fs.realpathSync(config.databasePath);
    const resolvedStats = lstatPath(operationalReal, "operational database");
    if (!resolvedStats.isFile()) throw new ReadonlyDatabaseError("operational database must be a regular file");
  } else if (!operationalStats.isFile()) {
    throw new ReadonlyDatabaseError("operational database must be a regular file");
  }
  const operationalReal = fs.realpathSync(config.databasePath);
  const operationalIdentity = identity(fs.statSync(config.databasePath), "operational database");
  const sharedCanonicalDatabase = config.canonicalWorkflowMode === "disposable";
  if (
    isContained(rootReal, operationalReal) &&
    config.candidateRuntimeMode === undefined &&
    !sharedCanonicalDatabase
  ) {
    throw new ReadonlyDatabaseError("auth disposable root may not contain the operational database");
  }

  const writerLstat = lstatPath(config.authWriteDatabasePath, "auth write database");
  if (writerLstat.isSymbolicLink() || !writerLstat.isFile()) {
    throw new ReadonlyDatabaseError("auth write database must be an existing regular file without symlink indirection");
  }
  rejectSymlinkComponentsWithin(config.authDisposableRoot, config.authWriteDatabasePath, "auth write database");
  const writerReal = fs.realpathSync(config.authWriteDatabasePath);
  if (!isContained(rootReal, writerReal)) {
    throw new ReadonlyDatabaseError("auth write database must reside inside the auth disposable root");
  }
  const writerStats = fs.statSync(config.authWriteDatabasePath);
  if (
    identity(writerStats, "auth write database") === operationalIdentity &&
    config.candidateRuntimeMode === undefined &&
    !sharedCanonicalDatabase
  ) {
    throw new ReadonlyDatabaseError("auth write database must not identify the operational database");
  }

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${config.authWriteDatabasePath}${suffix}`;
    const sidecarStats = optionalLstatPath(sidecar, `auth write database ${suffix} sidecar`);
    if (!sidecarStats) continue;
    if (sidecarStats.isSymbolicLink() || !sidecarStats.isFile()) {
      throw new ReadonlyDatabaseError(`auth write database ${suffix} sidecar must be a regular file`);
    }
    rejectSymlinkComponentsWithin(config.authDisposableRoot, sidecar, `auth write database ${suffix} sidecar`);
    if (!isContained(rootReal, fs.realpathSync(sidecar))) {
      throw new ReadonlyDatabaseError(`auth write database ${suffix} sidecar escapes the disposable root`);
    }
  }

  return { writerStats, operationalStats: fs.statSync(config.databasePath) };
}

export function openReadonlyDatabase(config: BackendConfig): ReadonlyDatabase {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(config.databasePath);
  } catch (error) {
    throw new ReadonlyDatabaseError("configured database file is unavailable", { cause: error });
  }
  if (!stats.isFile()) {
    throw new ReadonlyDatabaseError("configured database path is not a file");
  }

  let sqlite: Database.Database;
  try {
    sqlite = new Database(config.databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: config.busyTimeoutMs
    });
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("query_only = ON");
    sqlite.pragma(`busy_timeout = ${config.busyTimeoutMs}`);
    sqlite.prepare("SELECT 1").get();
  } catch (error) {
    throw new ReadonlyDatabaseError("configured database could not be opened read-only", {
      cause: error
    });
  }

  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close: () => sqlite.close()
  };
}

export function openAuthWriteDatabase(config: BackendConfig): ReadonlyDatabase {
  if (!config.authWriteEnabled || !config.authWriteDatabasePath || (config.authWriteMode !== "test" && config.authWriteMode !== "operational")) {
    throw new ReadonlyDatabaseError("authentication write isolation is not enabled");
  }
  const operational = config.authWriteMode === "operational";
  if (operational) {
    if (config.catalogReadMode !== "canonical-operational" || !config.canonicalStorageRoot || path.resolve(config.authWriteDatabasePath) !== path.join(path.resolve(config.canonicalStorageRoot), "store.sqlite")) {
      throw new ReadonlyDatabaseError("operational auth writer must use the canonical storage-v2 database");
    }
    const stats = lstatPath(config.authWriteDatabasePath, "canonical operational database");
    if (stats.isSymbolicLink() || !stats.isFile()) throw new ReadonlyDatabaseError("canonical operational database must be a regular file");
  }
  const before = operational ? undefined : validateAuthWriterTarget(config);
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(config.authWriteDatabasePath, { timeout: config.busyTimeoutMs });
    const after = operational ? undefined : validateAuthWriterTarget(config);
    if (before && after && (identity(after.writerStats, "auth write database") !== identity(before.writerStats, "auth write database") ||
        identity(after.operationalStats, "operational database") !== identity(before.operationalStats, "operational database"))) {
      throw new ReadonlyDatabaseError("database identity changed during auth writer validation");
    }
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma(`busy_timeout = ${config.busyTimeoutMs}`);
    sqlite.prepare("SELECT 1").get();
    // Test mode migrates only its isolated writer. Operational mode opens the
    // already-bootstrapped canonical database and only applies idempotent
    // compatibility migrations.
    applyFederationMigrations(sqlite);
    applyApplicationMigrations(sqlite);
    const requiredTables = ["users", "api_tokens", "groups", "user_groups", "registration_tokens", "store_settings"];
    const present = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (requiredTables.some((table) => !present.has(table))) {
      throw new ReadonlyDatabaseError("auth write database does not contain the compatible schema");
    }
  } catch (error) {
    sqlite?.close();
    if (error instanceof ReadonlyDatabaseError) throw error;
    if (error instanceof FederationMigrationError) throw new ReadonlyDatabaseError("auth write database does not contain the compatible schema", { cause: error });
    throw new ReadonlyDatabaseError("configured auth write database could not be opened", { cause: error });
  }
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

export class ReadonlyDatabaseManager {
  private resource: ReadonlyDatabase | undefined;

  constructor(private readonly config: BackendConfig) {}

  get(): ReadonlyDatabase {
    if (!this.resource) {
      this.resource = openReadonlyDatabase(this.config);
    }
    return this.resource;
  }

  check(): boolean {
    try {
      this.get().sqlite.prepare("SELECT 1").get();
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  close(): void {
    this.resource?.close();
    this.resource = undefined;
  }
}
