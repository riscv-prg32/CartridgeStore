import Database from "better-sqlite3";

import { KeyRegistry } from "./registry.js";
import { SecretStore } from "./service.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const [operation, ...args] = process.argv.slice(2);
  const databasePath = required(args, "--database");
  const registryPath = required(args, "--key-registry");
  const snapshotPath = option(args, "--snapshot");
  const confirm = args.includes("--confirm");
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  try {
    const registry = KeyRegistry.fromFile(registryPath, option(args, "--application-data"));
    const applicationData = option(args, "--application-data");
    const store = new SecretStore({ keyRegistryPath: registry.filePath, ...(applicationData ? { applicationDataRoot: applicationData } : {}) });
    if (operation === "migrate") {
      const result = store.migrate(database, databasePath, { confirm, ...(snapshotPath ? { snapshotPath } : {}) });
      process.stdout.write(JSON.stringify({ ok: true, operation, dry_run: !confirm, ...result }) + "\n");
    } else if (operation === "rollback") {
      if (!snapshotPath) throw new Error("--snapshot is required");
      store.rollback(database, databasePath, snapshotPath, confirm);
      process.stdout.write(JSON.stringify({ ok: true, operation }) + "\n");
    } else if (operation === "rotate") {
      const result = store.rotate(database, {});
      process.stdout.write(JSON.stringify({ ok: true, operation, ...result }) + "\n");
    } else {
      throw new Error("operation must be migrate, rollback, or rotate");
    }
  } finally { database.close(); }
}

try { main(); } catch (error) {
  const message = error instanceof Error ? error.message : "secret operation failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
