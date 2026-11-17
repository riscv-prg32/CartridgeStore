import path from "node:path";

import { parseBoundedJson, writeAtomic } from "../legacy/filesystem.js";
import {
  DISPOSABLE_MIGRATION_AUTHORIZATION,
  MigrationError,
  migrateLegacySnapshot,
  migrationStatus,
  disposeMigrationTarget,
  verifyMigration,
  type MigrationConfig
} from "./index.js";

function usage(): string {
  return [
    "Usage:",
    "  storage-migration migrate --config <migration-config.json> [--output <result.json>]",
    "  storage-migration resume --config <migration-config.json> [--output <result.json>]",
    "  storage-migration verify --config <migration-config.json> [--output <result.json>]",
    "  storage-migration status --target <target-root> --migration <migration-id>",
    "  storage-migration dispose --target <target-root> --migration <migration-id> --authorization <token>",
    "",
    `The config must contain authorization=${DISPOSABLE_MIGRATION_AUTHORIZATION}.`,
    "Source and target roots are explicit; production environment defaults are never used."
  ].join("\n");
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new MigrationError(`missing ${name}`, "migration_cli_argument_missing");
  return value;
}

function loadConfig(filePath: string): MigrationConfig {
  const parsed = parseBoundedJson(path.resolve(filePath), 4 * 1024 * 1024, "migration config");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new MigrationError("migration config must be an object", "migration_config_invalid");
  return parsed as MigrationConfig;
}

function writeResult(output: string | undefined, result: unknown): void {
  const text = `${JSON.stringify(result)}\n`;
  if (output) writeAtomic(path.resolve(output), text);
  process.stdout.write(text);
}

function main(args: readonly string[]): number {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return command ? 0 : 2;
  }
  if (command === "status") {
    const journal = migrationStatus(option(args, "--target"), option(args, "--migration"));
    writeResult(undefined, { found: journal !== null, journal });
    return journal ? 0 : 2;
  }
  if (command === "dispose") {
    disposeMigrationTarget(option(args, "--target"), option(args, "--migration"), option(args, "--authorization"));
    writeResult(undefined, { ok: true, disposed: true });
    return 0;
  }
  const config = loadConfig(option(args, "--config"));
  const output = args.includes("--output") ? option(args, "--output") : undefined;
  const result = command === "verify" ? verifyMigration(config) : command === "migrate" || command === "resume" ? migrateLegacySnapshot(config) : (() => { throw new MigrationError(`unknown command ${command}`, "migration_cli_command_unknown"); })();
  writeResult(output, {
    ok: result.ok,
    alreadyCompleted: result.alreadyCompleted,
    migrationId: result.migrationId,
    phase: result.phase,
    targetRoot: result.targetRoot,
    plan: result.plan,
    journal: result.journal,
    verification: result.verification
  });
  return result.ok ? 0 : 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const code = error instanceof MigrationError ? error.code : "migration_failed";
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 2;
}
