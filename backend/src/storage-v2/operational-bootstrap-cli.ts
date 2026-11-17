import path from "node:path";

import { initializeOperationalStorage } from "./database.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

try {
  const root = path.resolve(argument("--root"));
  const authorization = argument("--authorization");
  const storage = initializeOperationalStorage(root, authorization);
  try {
    const metadata = storage.sqlite.prepare(
      "SELECT application, schema_version, storage_layout_version, publication_journal_version, backup_format_version, state FROM storage_metadata WHERE singleton_id = 1"
    ).get();
    process.stdout.write(`${JSON.stringify({ ok: true, root, metadata })}\n`);
  } finally {
    storage.close();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "operational storage bootstrap failed"}\n`);
  process.exitCode = 1;
}
