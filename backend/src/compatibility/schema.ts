import assert from "node:assert/strict";

import type { SchemaSnapshot } from "../db/schema-inspection.js";

export interface SchemaDifference {
  readonly severity: "critical" | "high" | "medium";
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

export function compareSchemaSnapshots(expected: SchemaSnapshot, actual: SchemaSnapshot): SchemaDifference[] {
  const differences: SchemaDifference[] = [];
  const expectedTables = new Map(expected.tables.map((table) => [table.name, table]));
  const actualTables = new Map(actual.tables.map((table) => [table.name, table]));
  for (const tableName of new Set([...expectedTables.keys(), ...actualTables.keys()])) {
    const expectedTable = expectedTables.get(tableName);
    const actualTable = actualTables.get(tableName);
    if (!expectedTable || !actualTable) {
      differences.push({ severity: "critical", path: `table.${tableName}`, expected: Boolean(expectedTable), actual: Boolean(actualTable) });
      continue;
    }
    if (expectedTable.autoIncrement !== actualTable.autoIncrement) {
      differences.push({ severity: "high", path: `table.${tableName}.autoIncrement`, expected: expectedTable.autoIncrement, actual: actualTable.autoIncrement });
    }
    const expectedColumns = new Map(expectedTable.columns.map((column) => [column.name, column]));
    const actualColumns = new Map(actualTable.columns.map((column) => [column.name, column]));
    for (const columnName of new Set([...expectedColumns.keys(), ...actualColumns.keys()])) {
      const left = expectedColumns.get(columnName);
      const right = actualColumns.get(columnName);
      if (!left || !right) {
        differences.push({ severity: "critical", path: `table.${tableName}.column.${columnName}`, expected: Boolean(left), actual: Boolean(right) });
        continue;
      }
      for (const key of ["type", "notNull", "primaryKeyPosition", "defaultValue"] as const) {
        if (left[key] !== right[key]) {
          differences.push({ severity: key === "type" || key === "notNull" ? "high" : "medium", path: `table.${tableName}.column.${columnName}.${key}`, expected: left[key], actual: right[key] });
        }
      }
    }
    const indexKey = (index: SchemaSnapshot["tables"][number]["indexes"][number]): string => `${index.name}:${index.unique}:${index.columns.join(",")}:${index.orders.join(",")}`;
    const expectedIndexes = sorted(expectedTable.indexes, indexKey).map(indexKey);
    const actualIndexes = sorted(actualTable.indexes, indexKey).map(indexKey);
    if (JSON.stringify(expectedIndexes) !== JSON.stringify(actualIndexes)) {
      differences.push({ severity: "high", path: `table.${tableName}.indexes`, expected: expectedIndexes, actual: actualIndexes });
    }
    const foreignKeyKey = (foreignKey: SchemaSnapshot["tables"][number]["foreignKeys"][number]): string => [
      foreignKey.column,
      foreignKey.foreignTable,
      foreignKey.foreignColumn,
      foreignKey.onUpdate,
      foreignKey.onDelete,
      foreignKey.match
    ].join(":");
    const expectedForeignKeys = sorted(expectedTable.foreignKeys, foreignKeyKey).map(foreignKeyKey);
    const actualForeignKeys = sorted(actualTable.foreignKeys, foreignKeyKey).map(foreignKeyKey);
    if (JSON.stringify(expectedForeignKeys) !== JSON.stringify(actualForeignKeys)) {
      differences.push({ severity: "high", path: `table.${tableName}.foreignKeys`, expected: expectedForeignKeys, actual: actualForeignKeys });
    }
  }
  return differences;
}

export function assertSchemaCompatible(expected: SchemaSnapshot, actual: SchemaSnapshot): void {
  const differences = compareSchemaSnapshots(expected, actual);
  assert.deepEqual(differences, [], JSON.stringify(differences, null, 2));
}
