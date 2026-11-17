import fs from "node:fs";
import path from "node:path";

import {
  assertOutputOutsideSnapshot,
  canonicalJson,
  parseBoundedJson,
  writeAtomic
} from "./filesystem.js";
import { inventoryLegacySnapshot, renderValidationReport } from "./inventory.js";
import { verifyLegacyManifest } from "./manifest.js";
import type { LegacyManifest, LegacySnapshotConfig } from "./types.js";

function usage(): string {
  return [
    "Usage:",
    "  legacy-inventory inventory --config <snapshot-config.json> --output <manifest.json> --report <report.md>",
    "  legacy-inventory verify --config <snapshot-config.json> --manifest <manifest.json> --output <verification.json>",
    "  legacy-inventory report --config <snapshot-config.json> --output <report.md>",
    "",
    "All paths are explicit. Output paths must be outside the legacy snapshot root."
  ].join("\n");
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function loadConfig(filePath: string): LegacySnapshotConfig {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("snapshot config must be an object");
  return parsed as LegacySnapshotConfig;
}

function loadManifest(filePath: string): LegacyManifest {
  const parsed = parseBoundedJson(path.resolve(filePath), 32 * 1024 * 1024, "manifest");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest must be an object");
  return parsed as LegacyManifest;
}

function ensureOutputs(config: LegacySnapshotConfig, outputs: readonly string[]): string[] {
  return outputs.map((output) => assertOutputOutsideSnapshot(config.root, output));
}

function outputAt(outputs: readonly string[], index: number): string {
  const output = outputs[index];
  if (!output) throw new Error("output path is required");
  return output;
}

function main(args: readonly string[]): number {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return command ? 0 : 2;
  }
  const config = loadConfig(option(args, "--config"));
  if (command === "inventory") {
    const output = option(args, "--output");
    const report = option(args, "--report");
    const outputs = ensureOutputs(config, [output, report]);
    const manifestPath = outputAt(outputs, 0);
    const reportPath = outputAt(outputs, 1);
    const result = inventoryLegacySnapshot(config);
    writeAtomic(manifestPath, result.canonicalManifest);
    writeAtomic(reportPath, result.humanReport);
    process.stdout.write(`${JSON.stringify({ manifest: manifestPath, report: reportPath, readiness: result.manifest.readiness })}\n`);
    return result.manifest.readiness.migrationReady ? 0 : 2;
  }
  if (command === "verify") {
    const manifestPath = option(args, "--manifest");
    const output = option(args, "--output");
    const outputPath = outputAt(ensureOutputs(config, [output]), 0);
    const result = verifyLegacyManifest(config, loadManifest(manifestPath));
    writeAtomic(outputPath, `${canonicalJson(result)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 2;
  }
  if (command === "report") {
    const output = option(args, "--output");
    const outputPath = outputAt(ensureOutputs(config, [output]), 0);
    const result = inventoryLegacySnapshot(config);
    writeAtomic(outputPath, renderValidationReport(result.manifest));
    process.stdout.write(`${JSON.stringify({ report: outputPath, readiness: result.manifest.readiness })}\n`);
    return result.manifest.readiness.migrationReady ? 0 : 2;
  }
  throw new Error(`unknown command ${command}`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "legacy inventory failed"}\n`);
  process.exitCode = 2;
}
