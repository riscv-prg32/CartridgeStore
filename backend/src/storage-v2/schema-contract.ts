import Database from "better-sqlite3";

import { COMPATIBLE_SCHEMA_SQL, TARGET_SCHEMA_SQL } from "./schema.js";

export interface SchemaContractDifference {
  readonly category: string;
  readonly name: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export function extractDocumentedSql(markdown: string): string {
  const blocks: string[] = [];
  const pattern = /```sql\s*([\s\S]*?)```/gu;
  for (const match of markdown.matchAll(pattern)) blocks.push(match[1] ?? "");
  if (blocks.length === 0) throw new Error("schema documentation contains no executable SQL blocks");
  return blocks.join("\n");
}

function normalizeSql(value: string | null): string {
  return (value ?? "")
    .replace(/\s+/gu, " ")
    .replace(/\(\s+/gu, "(")
    .replace(/\s+\)/gu, ")")
    .replace(/\s*,\s*/gu, ",")
    .trim()
    .toLowerCase();
}

function tableShape(sqlite: Database.Database): Record<string, unknown> {
  const tables = (sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>);
  const shape: Record<string, unknown> = {};
  for (const table of tables) {
    const columns = sqlite.prepare(`PRAGMA table_info("${table.name}")`).all() as Array<Record<string, unknown>>;
    const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list("${table.name}")`).all() as Array<Record<string, unknown>>;
    const indexes = sqlite.prepare(`PRAGMA index_list("${table.name}")`).all() as Array<Record<string, unknown>>;
    shape[table.name] = {
      columns: columns.map((column) => ({ name: column.name, type: column.type, notnull: column.notnull, pk: column.pk, dflt_value: column.dflt_value })),
      foreignKeys: foreignKeys.map((foreignKey) => ({ table: foreignKey.table, from: foreignKey.from, to: foreignKey.to, on_update: foreignKey.on_update, on_delete: foreignKey.on_delete })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      indexes: indexes.map((index) => ({
        name: index.name,
        unique: index.unique,
        partial: index.partial,
        columns: (sqlite.prepare(`PRAGMA index_info("${String(index.name).replaceAll('"', '""')}")`).all() as Array<Record<string, unknown>>).sort((left, right) => Number(left.seqno) - Number(right.seqno)).map((column) => column.name)
      })).sort((left, right) => String(left.name).localeCompare(String(right.name))),
      sql: normalizeSql(table.sql)
    };
  }
  return shape;
}

function executeSchema(sql: string): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(COMPATIBLE_SCHEMA_SQL);
  sqlite.exec(sql);
  return sqlite;
}

export function compareDocumentedTargetSchema(markdown: string): readonly SchemaContractDifference[] {
  const documented = executeSchema(extractDocumentedSql(markdown));
  const executable = executeSchema(TARGET_SCHEMA_SQL);
  const expected = tableShape(executable) as Record<string, Record<string, unknown>>;
  const actual = tableShape(documented) as Record<string, Record<string, unknown>>;
  const differences: SchemaContractDifference[] = [];
  for (const table of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    if (!(table in expected) || !(table in actual)) {
      differences.push({ category: "table", name: table, expected: expected[table] ?? null, actual: actual[table] ?? null });
      continue;
    }
    for (const key of ["columns", "foreignKeys", "indexes", "sql"] as const) {
      if (JSON.stringify(expected[table]?.[key]) !== JSON.stringify(actual[table]?.[key])) differences.push({ category: key, name: table, expected: expected[table]?.[key] ?? null, actual: actual[table]?.[key] ?? null });
    }
  }
  documented.close();
  executable.close();
  return differences;
}
