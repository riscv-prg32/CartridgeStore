import { openTargetStorage } from "./database.js";
import { auditStorage } from "./integrity.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

try {
  const root = argument("--root");
  const resource = openTargetStorage(root, "read-only");
  try {
    const sqliteIntegrity = resource.sqlite.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown };
    const foreignKeys = resource.sqlite.pragma("foreign_key_check") as readonly Record<string, unknown>[];
    const audit = auditStorage(resource.sqlite, resource.paths);
    const ok = sqliteIntegrity.integrity_check === "ok" && foreignKeys.length === 0 && audit.ok;
    process.stdout.write(`${JSON.stringify({ ok, command: "storage:integrity", root: resource.paths.root, sqlite_integrity: sqliteIntegrity.integrity_check ?? null, foreign_key_violations: foreignKeys.length, audit })}\n`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    resource.close();
  }
} catch {
  process.stderr.write(`${JSON.stringify({ error: { code: "storage_integrity_failed" } })}\n`);
  process.exitCode = 1;
}
