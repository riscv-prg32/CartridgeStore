import type Database from "better-sqlite3";

export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: unknown;
  readonly primaryKeyPosition: number;
}

export interface SchemaForeignKey {
  readonly column: string;
  readonly foreignTable: string;
  readonly foreignColumn: string;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

export interface SchemaIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
  readonly orders: readonly ("ASC" | "DESC" | "NONE")[];
}

export interface SchemaTable {
  readonly name: string;
  readonly columns: readonly SchemaColumn[];
  readonly indexes: readonly SchemaIndex[];
  readonly foreignKeys: readonly SchemaForeignKey[];
  readonly sql: string;
  readonly autoIncrement: boolean;
}

export interface SchemaSnapshot {
  readonly tables: readonly SchemaTable[];
}

interface TableRow {
  name: string;
}

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface IndexRow {
  name: string;
  unique: number;
}

interface IndexColumnRow {
  seqno: number;
  name: string | null;
  desc: number;
  key: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface SqlRow {
  sql: string | null;
}

export function inspectSchema(sqlite: Database.Database): SchemaSnapshot {
  const tableRows = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as TableRow[];

  const tables = tableRows.map((table) => {
    const escaped = table.name.replaceAll('"', '""');
    const columns = (
      sqlite.prepare(`PRAGMA table_info("${escaped}")`).all() as ColumnRow[]
    ).map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.notnull === 1,
      defaultValue: column.dflt_value,
      primaryKeyPosition: column.pk
    }));

    const indexes = (
      sqlite.prepare(`PRAGMA index_list("${escaped}")`).all() as IndexRow[]
    ).map((index) => {
      const indexName = index.name.replaceAll('"', '""');
      const indexColumns = sqlite
        .prepare(`PRAGMA index_xinfo("${indexName}")`)
        .all() as IndexColumnRow[];
      return {
        name: index.name,
        unique: index.unique === 1,
        columns: indexColumns.filter((item) => item.key === 1).flatMap((item) => (item.name ? [item.name] : [])),
        orders: indexColumns
          .filter((item) => item.key === 1)
          .sort((left, right) => left.seqno - right.seqno)
          .map((item): "ASC" | "DESC" => (item.desc === 1 ? "DESC" : "ASC"))
      };
    });

    const foreignKeys = (
      sqlite.prepare(`PRAGMA foreign_key_list("${escaped}")`).all() as ForeignKeyRow[]
    ).map((foreignKey) => ({
      column: foreignKey.from,
      foreignTable: foreignKey.table,
      foreignColumn: foreignKey.to,
      onUpdate: foreignKey.on_update,
      onDelete: foreignKey.on_delete,
      match: foreignKey.match
    }));
    const sql = (
      sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table.name) as SqlRow | undefined
    )?.sql ?? "";

    return {
      name: table.name,
      columns,
      indexes,
      foreignKeys,
      sql,
      autoIncrement: /AUTOINCREMENT/i.test(sql)
    };
  });

  return { tables };
}

export const REQUIRED_TABLES = [
  "api_tokens",
  "cartridge_submissions",
  "download_events",
  "groups",
  "registration_tokens",
  "runs",
  "samples",
  "scores",
  "store_settings",
  "user_groups",
  "users"
] as const;
