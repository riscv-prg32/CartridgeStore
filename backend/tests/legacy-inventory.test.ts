import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildSubmissionCartridge } from "../src/submission/prg32.js";
import { COMPATIBLE_SCHEMA_SQL } from "../src/storage-v2/schema.js";
import { openLegacySnapshot } from "../src/storage-v2/legacy/database.js";
import { inventoryLegacySnapshot } from "../src/storage-v2/legacy/inventory.js";
import { verifyLegacyManifest } from "../src/storage-v2/legacy/manifest.js";
import type { LegacySnapshotConfig } from "../src/storage-v2/legacy/types.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const roots: string[] = [];

function legacyPayload(): Buffer {
  const output = Buffer.alloc(72 + 12);
  output.write("PRG2", 0, "ascii");
  output.writeUInt16LE(1, 4);
  output.writeUInt16LE(72, 8);
  output.writeUInt32LE(12, 16);
  Buffer.from("130000001300000013000000", "hex").copy(output, 72);
  return output;
}

function cartridge(id: string, version: string, architecture: "qemu" | "esp32c6"): Buffer {
  return Buffer.from(buildSubmissionCartridge(legacyPayload(), {
    abi: "prg32-metadata-1.0",
    id,
    title: "Fixture Game",
    version,
    authors: [{ name: "Fixture Author" }],
    tags: ["fixture"],
    runtime: { architecture },
    assets: { icon: "embedded" }
  }, PNG, architecture, PNG, {
    abi: "prg32-colophon-1.0",
    title: "Fixture Game",
    version,
    developer: { name: "Fixture Author" },
    authors: [{ name: "Fixture Author" }],
    controls: []
  }));
}

function configFor(root: string): LegacySnapshotConfig {
  return {
    root,
    databasePath: "store.sqlite",
    catalogPath: "index.json",
    dataRoot: ".",
    cartridgeRoot: "cartridges",
    preparedMarkerPath: ".snapshot.json",
    submissionRoot: "pending",
    mediaRoot: "custom"
  };
}

function createSnapshot(): { root: string; config: LegacySnapshotConfig; files: { qemu: Buffer; esp32c6: Buffer } } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52b-"));
  roots.push(root);
  const qemu = cartridge("org.example.fixture", "1.0.0", "qemu");
  const esp32c6 = cartridge("org.example.fixture", "1.0.0", "esp32c6");
  fs.mkdirSync(path.join(root, "cartridges/org.example.fixture/1.0.0"), { recursive: true });
  fs.mkdirSync(path.join(root, "pending/7"), { recursive: true });
  fs.mkdirSync(path.join(root, "custom"), { recursive: true });
  fs.writeFileSync(path.join(root, "cartridges/org.example.fixture/1.0.0/qemu.prg32"), qemu);
  fs.writeFileSync(path.join(root, "cartridges/org.example.fixture/1.0.0/esp32c6.prg32"), esp32c6);
  fs.writeFileSync(path.join(root, "pending/7/qemu.prg32"), qemu);
  fs.writeFileSync(path.join(root, "custom/logo.bin"), Buffer.from("fixture-site-asset"));
  fs.writeFileSync(path.join(root, "cartridges/orphan.prg32"), Buffer.from("orphan"));
  const qemuSha = crypto.createHash("sha256").update(qemu).digest("hex");
  const espSha = crypto.createHash("sha256").update(esp32c6).digest("hex");
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({
    abi: "prg32-cartridge-store-index-1.0",
    updated_at: "2026-01-01T00:00:00Z",
    games: {
      "org.example.fixture": {
        id: "org.example.fixture",
        title: "Fixture Game",
        summary: "Synthetic legacy fixture",
        authors: [{ name: "Fixture Author" }],
        tags: ["fixture"],
        latest_version: "1.0.0",
        versions: {
          "1.0.0": {
            version: "1.0.0",
            metadata: { abi: "prg32-metadata-1.0", id: "org.example.fixture", title: "Fixture Game", version: "1.0.0" },
            colophon: { abi: "prg32-colophon-1.0", title: "Fixture Game", version: "1.0.0" },
            architectures: {
              esp32c6: { architecture: "esp32c6", filename: "cartridges/org.example.fixture/1.0.0/esp32c6.prg32", size: esp32c6.byteLength, sha256: espSha, has_screenshot: true },
              qemu: { architecture: "qemu", filename: "cartridges/org.example.fixture/1.0.0/qemu.prg32", size: qemu.byteLength, sha256: qemuSha, has_screenshot: true }
            }
          }
        }
      }
    }
  }, null, 2));
    const database = new Database(path.join(root, "store.sqlite"));
  database.pragma("foreign_keys = ON");
  database.exec(COMPATIBLE_SCHEMA_SQL);
  database.exec(`
    CREATE TABLE download_events (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, architecture TEXT NOT NULL, user_id INTEGER, ip_hash TEXT, user_agent TEXT, downloaded_at TEXT NOT NULL);
    CREATE INDEX download_events_game_idx ON download_events(game_id, downloaded_at);
    CREATE INDEX download_events_arch_idx ON download_events(architecture);
    CREATE TABLE cartridge_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_by TEXT NOT NULL DEFAULT '', reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT NOT NULL DEFAULT '', pending_dir TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL, architectures_json TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_at TEXT);
    CREATE INDEX cartridge_submissions_status_idx ON cartridge_submissions(status, created_at);
  `);
  database.prepare("INSERT INTO users(id, username, email, role) VALUES (1, 'fixture-user', 'fixture@example.test', 'publisher')").run();
  database.prepare("INSERT INTO cartridge_submissions(id, game_id, version, status, submitted_by_user_id, pending_dir, metadata_json, architectures_json, created_at) VALUES (7, 'org.example.fixture', '1.0.0', 'pending', 1, 'pending/7', ?, ?, '2026-01-01T00:00:00Z')").run(
    JSON.stringify({ abi: "prg32-metadata-1.0", id: "org.example.fixture", title: "Fixture Game", version: "1.0.0" }),
    JSON.stringify([{ architecture: "qemu", stored: "pending/7/qemu.prg32", file: "qemu.prg32" }])
  );
  database.prepare("INSERT INTO cartridge_submissions(id, game_id, version, status, submitted_by_user_id, reviewed_by_user_id, metadata_json, architectures_json, created_at, reviewed_at) VALUES (8, 'org.example.fixture', '1.0.0', 'rejected', 1, 1, ?, '[]', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')").run(JSON.stringify({ id: "org.example.fixture", version: "1.0.0" }));
  database.prepare("INSERT INTO download_events(game_id, version, architecture, user_id, ip_hash, user_agent, downloaded_at) VALUES ('org.example.fixture', '1.0.0', 'qemu', 1, 'secret-ip-hash', 'secret-user-agent', '2026-01-03T00:00:00Z')").run();
  database.close();
    fs.writeFileSync(path.join(root, ".snapshot.json"), JSON.stringify({ abi: "prg32-legacy-snapshot-1.0", state: "ready", database: "store.sqlite", catalog: "index.json", dataRoot: ".", cartridgeRoot: "cartridges" }));
  return { root, config: configFor(root), files: { qemu, esp32c6 } };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy inventory", () => {
  it("produces deterministic, secret-free inventory with embedded media and mappings", () => {
    const fixture = createSnapshot();
    const first = inventoryLegacySnapshot(fixture.config);
    const second = inventoryLegacySnapshot(fixture.config);
    expect(first.canonicalManifest).toBe(second.canonicalManifest);
    expect(first.manifest.readiness).toMatchObject({ inventoryComplete: true, migrationReady: true, operationalCutoverReady: false });
    expect(first.manifest.artifacts).toHaveLength(2);
    expect(first.manifest.media).toHaveLength(4);
    expect(first.manifest.submissions.map((item) => item.submissionId)).toEqual([7, 8]);
    expect(first.manifest.telemetry.mappedCount).toBe(1);
    expect(first.manifest.unreferencedFiles.map((item) => item.sourceRef)).toEqual(expect.arrayContaining(["cartridges/orphan.prg32", "custom/logo.bin"]));
    expect(first.canonicalManifest).not.toContain("secret-ip-hash");
    expect(first.canonicalManifest).not.toContain("secret-user-agent");
    expect(first.canonicalManifest).not.toContain("password_hash");
    const verified = verifyLegacyManifest(fixture.config, first.manifest);
    expect(verified).toMatchObject({ ok: true, manifestSha256Matches: true, sourceFingerprintsMatch: true, recordCountsMatch: true, artifactFilesMatch: true, storageFilesMatch: true });
  });

  it("opens the legacy database read-only and refuses writes", () => {
    const fixture = createSnapshot();
    const snapshot = openLegacySnapshot(fixture.config);
    expect(() => snapshot.sqlite.prepare("INSERT INTO store_settings(key, value) VALUES ('blocked', 'write')").run()).toThrow();
    snapshot.close();
  });

  it("classifies missing, orphaned, invalid-path, symlink, and unmappable telemetry cases", () => {
    const fixture = createSnapshot();
    fs.rmSync(path.join(fixture.root, "cartridges/org.example.fixture/1.0.0/qemu.prg32"));
    fs.writeFileSync(path.join(fixture.root, "index.json"), fs.readFileSync(path.join(fixture.root, "index.json"), "utf8").replace("cartridges/org.example.fixture/1.0.0/esp32c6.prg32", "../outside.prg32"));
    const database = new Database(path.join(fixture.root, "store.sqlite"));
    database.prepare("INSERT INTO download_events(game_id, version, architecture, downloaded_at) VALUES ('missing-game', '9.0.0', 'qemu', '2026-01-04T00:00:00Z')").run();
    database.close();
    fs.symlinkSync(path.join(fixture.root, "custom/logo.bin"), path.join(fixture.root, "cartridges/symlink.prg32"));
    const result = inventoryLegacySnapshot(fixture.config);
    const codes = result.manifest.anomalies.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(["missing_referenced_artifact", "invalid_legacy_path", "unreferenced_artifact_file", "symlink_escape", "unmappable_download_event"]));
    expect(result.manifest.readiness.migrationReady).toBe(false);
  });

  it("independently detects source mutation after inventory", () => {
    const fixture = createSnapshot();
    const result = inventoryLegacySnapshot(fixture.config);
    fs.appendFileSync(path.join(fixture.root, "cartridges/orphan.prg32"), "changed");
    const verified = verifyLegacyManifest(fixture.config, result.manifest);
    expect(verified.ok).toBe(false);
    expect(verified.storageFilesMatch).toBe(false);
  });

  it("fails closed for an unsupported legacy schema", () => {
    const fixture = createSnapshot();
    const databasePath = path.join(fixture.root, "store.sqlite");
    fs.rmSync(databasePath);
    const database = new Database(databasePath);
    database.exec("CREATE TABLE users(id INTEGER PRIMARY KEY)");
    database.close();
    expect(() => openLegacySnapshot(fixture.config)).toThrow("required tables");
  });

  it("runs the developer CLI inventory, verifier, and report commands", () => {
    const fixture = createSnapshot();
    const configPath = path.join(fixture.root, "snapshot-config.json");
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52b-output-"));
    roots.push(outputRoot);
    fs.writeFileSync(configPath, JSON.stringify(fixture.config));
    const cli = path.resolve("node_modules/.bin/tsx");
    const run = (args: readonly string[]) => execFileSync(cli, ["src/storage-v2/legacy/cli.ts", ...args], { cwd: path.resolve("."), encoding: "utf8" });
    run(["inventory", "--config", configPath, "--output", path.join(outputRoot, "manifest.json"), "--report", path.join(outputRoot, "report.md")]);
    run(["verify", "--config", configPath, "--manifest", path.join(outputRoot, "manifest.json"), "--output", path.join(outputRoot, "verification.json")]);
    run(["report", "--config", configPath, "--output", path.join(outputRoot, "report-again.md")]);
    expect(JSON.parse(fs.readFileSync(path.join(outputRoot, "verification.json"), "utf8"))).toMatchObject({ ok: true });
    expect(() => execFileSync(cli, ["src/storage-v2/legacy/cli.ts", "inventory", "--config", configPath, "--output", path.join(fixture.root, "unsafe.json"), "--report", path.join(outputRoot, "unsafe.md")], { cwd: path.resolve("."), encoding: "utf8" })).toThrow();
  });
});
