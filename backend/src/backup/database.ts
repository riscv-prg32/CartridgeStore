import Database from "better-sqlite3";

import { compareSchemaSnapshots } from "../compatibility/schema.js";
import {
  FEDERATION_TABLES,
  hasFederationTable,
} from "../db/federation-migrations.js";
import {
  inspectSchema,
  REQUIRED_TABLES,
  type SchemaSnapshot,
} from "../db/schema-inspection.js";
import {
  BACKUP_V2_ABI,
  BackupError,
  type BackupManifest,
} from "./format.js";
import { sha256 } from "./operations.js";

const APPLICATION_TABLES = [
  "application_settings",
  "admin_audit_events",
  "catalog_moderation",
  "setup_state",
  "webauthn_credentials",
  "webauthn_challenges",
] as const;

/** Calculates the stable schema fingerprint recorded in backup manifests. */
export function schemaFingerprint(snapshot: SchemaSnapshot): string {
  return sha256(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

/** Validates a staged database against the live installation schema. */
export function assertExpectedSchema(
  sqlite: Database.Database,
  expected: SchemaSnapshot,
  manifest: BackupManifest,
  legacyFingerprint?: string,
): SchemaSnapshot {
  const integrity = sqlite
    .prepare("PRAGMA integrity_check")
    .get() as { integrity_check?: unknown };
  if (integrity.integrity_check !== "ok") {
    throw new BackupError(
      "backup database integrity check failed",
      "backup_database_integrity",
    );
  }

  const foreignKeys = sqlite.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new BackupError(
      "backup database foreign-key check failed",
      "backup_database_foreign_keys",
    );
  }

  const actual = inspectSchema(sqlite);
  const federationExpected = expected.tables.some((table) =>
    FEDERATION_TABLES.includes(table.name as (typeof FEDERATION_TABLES)[number]),
  );
  const required = new Set<string>([
    ...(federationExpected
      ? [...REQUIRED_TABLES, ...FEDERATION_TABLES]
      : REQUIRED_TABLES),
    ...APPLICATION_TABLES.filter((name) =>
      actual.tables.some((table) => table.name === name),
    ),
  ]);
  if (
    actual.tables.some((table) => !required.has(table.name)) ||
    REQUIRED_TABLES.some(
      (name) => !actual.tables.some((table) => table.name === name),
    )
  ) {
    throw new BackupError(
      "backup database schema is incompatible",
      "backup_database_schema_incompatible",
    );
  }

  if (
    manifest.abi === BACKUP_V2_ABI &&
    manifest.schema.fingerprint !== schemaFingerprint(actual) &&
    manifest.schema.fingerprint !== legacyFingerprint
  ) {
    throw new BackupError(
      "backup database schema fingerprint is invalid",
      "backup_database_schema_incompatible",
    );
  }

  const differences = compareSchemaSnapshots(expected, actual);
  if (differences.length > 0) {
    throw new BackupError(
      "backup database schema is incompatible with this installation",
      "backup_database_schema_incompatible",
    );
  }

  return actual;
}

function databaseTableNames(snapshot: SchemaSnapshot): string[] {
  return snapshot.tables.map((table) => table.name).sort();
}

/** Restores a compatible SQLite snapshot while preserving session invalidation. */
export function restoreDatabase(
  live: Database.Database,
  sourcePath: string,
  expectedSchema: SchemaSnapshot,
): void {
  let source: Database.Database | undefined;
  let attached = false;
  try {
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const sourceSnapshot = inspectSchema(source);
    if (compareSchemaSnapshots(expectedSchema, sourceSnapshot).length > 0) {
      throw new BackupError(
        "backup database schema is incompatible",
        "backup_database_schema_incompatible",
      );
    }

    live.prepare("ATTACH DATABASE ? AS restored_backup").run(sourcePath);
    attached = true;
    live.pragma("foreign_keys = OFF");
    live.exec("BEGIN IMMEDIATE");
    for (const table of databaseTableNames(expectedSchema)) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      live.exec(`DELETE FROM main.${quoted}`);
    }
    for (const table of databaseTableNames(expectedSchema)) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      live.exec(
        `INSERT INTO main.${quoted} ` +
          `SELECT * FROM restored_backup.${quoted}`,
      );
    }
    const hasSequence = Boolean(
      source
        .prepare(
          "SELECT name FROM sqlite_master " +
            "WHERE type = 'table' AND name = 'sqlite_sequence'",
        )
        .get(),
    );
    if (hasSequence) {
      live.exec("DELETE FROM main.sqlite_sequence");
      live.exec(
        "INSERT INTO main.sqlite_sequence " +
          "SELECT * FROM restored_backup.sqlite_sequence",
      );
    }
    live.exec("COMMIT");
    live.pragma("foreign_keys = ON");
    if (hasFederationTable(live, "auth_sessions")) {
      live.exec("DELETE FROM auth_sessions; DELETE FROM federation_transactions;");
    }
    live.exec("DETACH DATABASE restored_backup");
    attached = false;
  } catch (error) {
    try {
      if (live.inTransaction) live.exec("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    try {
      live.pragma("foreign_keys = ON");
    } catch {
      // Preserve the original failure.
    }
    if (attached) {
      try {
        live.exec("DETACH DATABASE restored_backup");
      } catch {
        // Preserve the original failure.
      }
    }
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      "backup database restore failed",
      "backup_database_restore_failed",
      500,
      { cause: error },
    );
  } finally {
    source?.close();
  }
}
