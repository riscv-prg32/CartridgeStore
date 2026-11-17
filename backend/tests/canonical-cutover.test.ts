import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { buildSubmissionCartridge } from "../src/submission/prg32.js";
import { inventoryLegacySnapshot } from "../src/storage-v2/legacy/inventory.js";
import { verifyLegacyManifest } from "../src/storage-v2/legacy/manifest.js";
import type { LegacySnapshotConfig } from "../src/storage-v2/legacy/types.js";
import { COMPATIBLE_SCHEMA_SQL } from "../src/storage-v2/schema.js";
import { migrateLegacySnapshot, verifyMigration } from "../src/storage-v2/migration/executor.js";
import { DISPOSABLE_MIGRATION_AUTHORIZATION } from "../src/storage-v2/migration/types.js";
import {
  ENCRYPTED_BACKUP_V4_AUTHORIZATION,
  InMemoryBackupKeyProvider,
  assertNoSimultaneousWriters,
  CanonicalWriterLease,
  createEncryptedCanonicalBackup,
  restoreEncryptedBackup,
  runRollbackRehearsal,
  verifyEncryptedBackup
} from "../src/storage-v2/index.js";
import { CANONICAL_READ_AUTHORIZATION, CANONICAL_WRITE_AUTHORIZATION } from "../src/storage-v2/read-mode.js";
import { CANDIDATE_RUNTIME_AUTHORIZATION } from "../src/runtime/candidate.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+KcY5WQAAAABJRU5ErkJggg==", "base64");
const roots: string[] = [];

function cartridge(): Buffer {
  const legacy = Buffer.alloc(84);
  legacy.write("PRG2", 0, "ascii");
  legacy.writeUInt16LE(1, 4);
  legacy.writeUInt16LE(72, 8);
  legacy.writeUInt32LE(12, 16);
  Buffer.from("130000001300000013000000", "hex").copy(legacy, 72);
  return Buffer.from(buildSubmissionCartridge(legacy, {
    abi: "prg32-metadata-1.0",
    id: "org.example.m52g14",
    title: "M5.2g.14 Fixture",
    version: "1.0.0",
    authors: [{ name: "Synthetic" }],
    tags: ["fixture"],
    runtime: { architecture: "qemu" },
    assets: { icon: "embedded" }
  }, PNG, "qemu", PNG, {
    abi: "prg32-colophon-1.0",
    title: "M5.2g.14 Fixture",
    version: "1.0.0",
    developer: { name: "Synthetic" },
    authors: [{ name: "Synthetic" }],
    controls: []
  }));
}

function createLegacySnapshot(): { root: string; config: LegacySnapshotConfig; cartridge: Buffer } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52g14-legacy-"));
  roots.push(root);
  const bytes = cartridge();
  const cartridgeDirectory = path.join(root, "cartridges/org.example.m52g14/1.0.0");
  fs.mkdirSync(cartridgeDirectory, { recursive: true });
  fs.writeFileSync(path.join(cartridgeDirectory, "qemu.prg32"), bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({
    abi: "prg32-cartridge-store-index-1.0",
    updated_at: "2026-10-14T00:00:00Z",
    games: {
      "org.example.m52g14": {
        id: "org.example.m52g14",
        title: "M5.2g.14 Fixture",
        summary: "Disposable cutover fixture",
        authors: [{ name: "Synthetic" }],
        tags: ["fixture"],
        latest_version: "1.0.0",
        versions: {
          "1.0.0": {
            version: "1.0.0",
            metadata: { abi: "prg32-metadata-1.0", id: "org.example.m52g14", title: "M5.2g.14 Fixture", version: "1.0.0" },
            colophon: { abi: "prg32-colophon-1.0", title: "M5.2g.14 Fixture", version: "1.0.0" },
            architectures: {
              qemu: { architecture: "qemu", filename: "cartridges/org.example.m52g14/1.0.0/qemu.prg32", size: bytes.byteLength, sha256: sha256, has_screenshot: true }
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
    CREATE TABLE cartridge_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_by TEXT NOT NULL DEFAULT '', reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT NOT NULL DEFAULT '', pending_dir TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL, architectures_json TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_at TEXT);
  `);
  database.prepare("INSERT INTO users(id, username, email, role) VALUES (1, 'fixture-user', 'fixture@example.test', 'publisher')").run();
  database.close();
  fs.writeFileSync(path.join(root, ".snapshot.json"), JSON.stringify({ abi: "prg32-legacy-snapshot-1.0", state: "ready", database: "store.sqlite", catalog: "index.json", dataRoot: ".", cartridgeRoot: "cartridges" }));
  return {
    root,
    cartridge: bytes,
    config: { root, databasePath: "store.sqlite", catalogPath: "index.json", dataRoot: ".", cartridgeRoot: "cartridges", preparedMarkerPath: ".snapshot.json", submissionRoot: null, mediaRoot: null }
  };
}

function treeFingerprint(root: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) hash.update(path.relative(root, file)).update("\0").update(fs.readFileSync(file));
    }
  };
  walk(root);
  return hash.digest("hex");
}

function candidateEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PRG32_BACKEND_DB: path.join(root, "store.sqlite"),
    PRG32_BACKEND_STORE_DATA: root,
    PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: root,
    PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: CANONICAL_READ_AUTHORIZATION,
    PRG32_BACKEND_CANONICAL_WORKFLOW_MODE: "disposable",
    PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION: CANONICAL_WRITE_AUTHORIZATION,
    PRG32_BACKEND_CANDIDATE_MODE: "two-service-disposable",
    PRG32_BACKEND_CANDIDATE_AUTHORIZATION: CANDIDATE_RUNTIME_AUTHORIZATION,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: path.join(root, "store.sqlite"),
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: root,
    PRG32_BACKEND_SESSION_SECRET: "m52g14-cutover-session-secret-disposable",
    PRG32_BACKEND_SESSION_SECURE: "false",
    PRG32_BACKEND_MDNS_ENABLED: "false"
  };
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("disposable cutover dry-run", () => {
  it("runs legacy inventory, migration, canonical ownership, backup-v4, restore and rollback rehearsal", async () => {
    const fixture = createLegacySnapshot();
    const sourceFingerprint = treeFingerprint(fixture.root);
    const inventory = inventoryLegacySnapshot(fixture.config);
    expect(verifyLegacyManifest(fixture.config, inventory.manifest).ok).toBe(true);
    expect(inventory.manifest.readiness.migrationReady).toBe(true);

    const targetRoot = path.join(fixture.root, "..", "canonical-target");
    const failedTarget = path.join(fixture.root, "..", "failed-target");
    roots.push(targetRoot, failedTarget);
    expect(() => migrateLegacySnapshot({ snapshot: fixture.config, manifest: inventory.manifest, targetRoot: failedTarget, authorization: DISPOSABLE_MIGRATION_AUTHORIZATION, faultAt: "before-finalization" })).toThrow();
    const migration = migrateLegacySnapshot({ snapshot: fixture.config, manifest: inventory.manifest, targetRoot, authorization: DISPOSABLE_MIGRATION_AUTHORIZATION });
    expect(migration.ok).toBe(true);
    const verifiedMigration = verifyMigration({ snapshot: fixture.config, manifest: inventory.manifest, targetRoot, authorization: DISPOSABLE_MIGRATION_AUTHORIZATION });
    expect(verifiedMigration.verification?.ok).toBe(true);
    expect(treeFingerprint(fixture.root)).toBe(sourceFingerprint);

    const app = buildApp({ config: loadConfig(candidateEnvironment(targetRoot)), logger: false });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/games" })).json()).toMatchObject({ ok: true, games: [{ id: "org.example.m52g14" }] });
    expect(() => new CanonicalWriterLease(targetRoot)).toThrowError(/writer is already active/);
    await app.close();

    const workspace = path.join(fixture.root, "..", "backup-workspace");
    fs.mkdirSync(workspace);
    roots.push(workspace);
    const keys = new InMemoryBackupKeyProvider([{ id: "m52g14-key", status: "active", material: Buffer.alloc(32, 0x4d) }]);
    const archive = path.join(workspace, "canonical.backup4");
    await createEncryptedCanonicalBackup({ sourceRoot: targetRoot, outputPath: archive, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, writerQuiesced: true });
    expect(verifyEncryptedBackup(archive, { keyProvider: keys }).header.format_version).toBe(4);
    const restoredRoot = path.join(workspace, "restored");
    const restored = restoreEncryptedBackup({ archivePath: archive, targetRoot: restoredRoot, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys });
    expect(restored.state).toBe("completed");
    roots.push(restoredRoot);
    expect(treeFingerprint(path.join(targetRoot, "storage"))).toBe(treeFingerprint(path.join(restoredRoot, "storage")));

    expect(() => assertNoSimultaneousWriters(true, true)).toThrow(/simultaneous writers/);
    const rehearsal = runRollbackRehearsal({ sourceSnapshotUnchanged: true, inventoryVerified: true, migrationVerified: true, parityVerified: true, backupVerified: true, restoreVerified: true, failureDetected: true });
    expect(rehearsal).toMatchObject({ ok: true, finalState: "completed", simultaneousWriterRejected: true });
  }, 60_000);
});
