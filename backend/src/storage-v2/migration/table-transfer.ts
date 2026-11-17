import type Database from "better-sqlite3";

import { MigrationError } from "./errors.js";

function columnNames(sqlite: Database.Database, table: string): string[] {
  return (
    sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function primaryKeyColumns(sqlite: Database.Database, table: string): string[] {
  return (
    sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((row) => row.name);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Buffer.isBuffer(left) || Buffer.isBuffer(right)) {
    return Buffer.from(left as Uint8Array).equals(
      Buffer.from(right as Uint8Array),
    );
  }
  return left === right;
}

/** Copies one compatible legacy table idempotently into the target schema. */
export function copyCompatibleTable(
  source: Database.Database,
  target: Database.Database,
  table: string,
): void {
  const sourceColumns = columnNames(source, table);
  const targetColumns = new Set(columnNames(target, table));
  const columns = sourceColumns.filter((column) => targetColumns.has(column));
  const keys = primaryKeyColumns(target, table);
  if (columns.length === 0 || keys.length === 0) {
    throw new MigrationError(
      "compatible table mapping is incomplete",
      "migration_table_mapping_invalid",
    );
  }
  const sourceRows = source.prepare(`SELECT * FROM "${table}" ORDER BY rowid`);
  const placeholders = columns.map(() => "?").join(", ");
  const insert = target.prepare(
    `INSERT INTO "${table}" (${columns
      .map((column) => `"${column}"`)
      .join(", ")}) VALUES (${placeholders})`,
  );
  const lookup = target.prepare(
    `SELECT ${columns
      .map((column) => `"${column}"`)
      .join(", ")} FROM "${table}" WHERE ${keys
      .map((key) => `"${key}" = ?`)
      .join(" AND ")}`,
  );
  target.transaction(() => {
    for (const row of sourceRows.iterate() as Iterable<Record<string, unknown>>) {
      const keyValues = keys.map((key) => row[key]);
      const existing = lookup.get(...keyValues) as
        | Record<string, unknown>
        | undefined;
      if (existing) {
        if (
          columns.some((column) => !sameValue(existing[column], row[column]))
        ) {
          throw new MigrationError(
            "target compatible record conflicts with source",
            "migration_target_conflict",
          );
        }
        continue;
      }
      try {
        insert.run(...columns.map((column) => row[column]));
      } catch (error) {
        throw new MigrationError(
          "compatible table transfer failed",
          "migration_table_transfer_failed",
          { cause: error },
        );
      }
    }
  })();
}
