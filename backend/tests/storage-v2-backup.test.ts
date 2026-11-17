import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createZip } from "../src/backup/archive.js";
import {
  CANONICAL_BACKUP_AUTHORIZATION,
  createCanonicalBackup,
  initializeDisposableStorage,
  ObjectStore,
  restoreCanonicalBackup,
  assertNoSimultaneousWriters,
  assessPostCutoverRollback,
  runRollbackRehearsal,
  verifyCanonicalBackup
} from "../src/storage-v2/index.js";
import { StagingStore } from "../src/storage-v2/staging.js";

const roots: string[] = [];

function root(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

function seed(rootPath: string): { readonly staged: Buffer; readonly artifact: Buffer; readonly media: Buffer } {
  const resource = initializeDisposableStorage(rootPath);
  const artifact = Buffer.from("synthetic PRG32 artifact bytes");
  const media = Buffer.from("synthetic PNG bytes");
  resource.sqlite.prepare("INSERT INTO users(username, email, role) VALUES ('publisher', 'publisher@example.test', 'user')").run();
  resource.sqlite.prepare("INSERT INTO cartridges(cartridge_id, created_at, updated_at, publisher_user_id) VALUES ('fixture', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)").run();
  resource.sqlite.prepare("INSERT INTO releases(release_id, cartridge_id, version, revision, state, title, metadata_json, created_at, published_at, published_order) VALUES ('release', 'fixture', '1.0.0', 1, 'published', 'Fixture', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)").run();
  const store = new ObjectStore(resource.sqlite, resource.paths);
  const artifactObject = store.store("artifact", artifact, "application/vnd.prg32.cartridge", { objectId: "obj_0123456789abcdef" });
  const mediaObject = store.store("media", media, "image/png", { objectId: "obj_abcdef0123456789" });
  resource.sqlite.prepare("INSERT INTO artifacts(artifact_id, release_id, architecture, object_id, state, created_at) VALUES ('artifact', 'release', 'qemu', ?, 'published', '2026-01-01T00:00:00.000Z')").run(artifactObject.objectId);
  resource.sqlite.prepare("INSERT INTO media(media_id, release_id, architecture, kind, object_id, created_at) VALUES ('media', 'release', 'qemu', 'icon', ?, '2026-01-01T00:00:00.000Z')").run(mediaObject.objectId);
  resource.sqlite.prepare("INSERT INTO submissions(submission_id, cartridge_id, version, status, submitted_by, created_at) VALUES (7, 'fixture', '2.0.0', 'pending_review', 'publisher', '2026-01-01T00:00:00.000Z')").run();
  const staged = Buffer.from("private staged submission bytes");
  const stagedRecord = new StagingStore(resource.paths).stageSubmissionArtifact(7, "qemu", "fixture.prg32", staged);
  resource.sqlite.prepare("INSERT INTO submission_artifacts(submission_artifact_id, submission_id, architecture, source_filename, staging_key, sha256, size_bytes, validation_state, metadata_json, created_at) VALUES ('submission-artifact', 7, 'qemu', ?, ?, ?, ?, 'validated', '{}', '2026-01-01T00:00:00.000Z')").run(stagedRecord.sourceFilename, stagedRecord.stagingKey, stagedRecord.sha256, stagedRecord.sizeBytes);
  resource.sqlite.prepare("INSERT INTO review_decisions(decision_id, submission_id, decision, reviewer_name, created_at) VALUES ('decision', 7, 'rejected', '', '2026-01-01T00:00:00.000Z')").run();
  resource.sqlite.prepare("INSERT INTO store_settings(key, value) VALUES ('theme', 'dark')").run();
  resource.close();
  return { staged, artifact, media };
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("canonical storage-v2 backup and restore", () => {
  it("creates a streaming v3 backup, independently verifies it, and restores exact objects and staging", async () => {
    const workspace = root("prg32-backup-test-");
    const source = path.join(workspace, "source");
    const target = path.join(workspace, "restore");
    const archive = path.join(workspace, "canonical-v3.zip");
    const bytes = seed(source);
    const created = await createCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: CANONICAL_BACKUP_AUTHORIZATION, writerQuiesced: true });
    expect(created.manifest.format_version).toBe(3);
    expect(created.manifest.versions).toEqual({ schemaVersion: 2, storageLayoutVersion: 2, publicationJournalVersion: 1, backupFormatVersion: 3 });
    expect(fs.existsSync(created.completionMarker)).toBe(true);
    const verified = verifyCanonicalBackup(archive);
    expect(verified.archiveSha256).toBe(hashFile(archive));
    expect(verified.manifest.object_count).toBe(2);
    const restored = restoreCanonicalBackup({ archivePath: archive, targetRoot: target, authorization: CANONICAL_BACKUP_AUTHORIZATION });
    expect(restored.state).toBe("completed");
    expect(restored.report.integrity.ok).toBe(true);
    expect(fs.readFileSync(path.join(target, "storage/objects/artifacts/obj_0123456789abcdef.prg32"))).toEqual(bytes.artifact);
    expect(fs.readFileSync(path.join(target, "storage/objects/media/obj_abcdef0123456789.png"))).toEqual(bytes.media);
    expect(fs.readFileSync(path.join(target, "storage/staging/submissions/7/artifacts/qemu.prg32"))).toEqual(bytes.staged);
    const restoredDb = new Database(path.join(target, "store.sqlite"), { readonly: true });
    expect(restoredDb.prepare("SELECT state FROM storage_metadata WHERE singleton_id = 1").get()).toEqual({ state: "ready" });
    expect(restoredDb.prepare("SELECT status FROM submissions WHERE submission_id = 7").get()).toEqual({ status: "pending_review" });
    expect(restoredDb.prepare("SELECT value FROM store_settings WHERE key = 'theme'").get()).toEqual({ value: "dark" });
    restoredDb.close();
  });

  it("requires disposable authorization and writer quiescence, and never overwrites a completed archive", async () => {
    const workspace = root("prg32-backup-guard-");
    const source = path.join(workspace, "source"); seed(source);
    const archive = path.join(workspace, "backup.zip");
    await expect(createCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: "", writerQuiesced: true })).rejects.toMatchObject({ code: "canonical_backup_authorization_required" });
    await expect(createCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: CANONICAL_BACKUP_AUTHORIZATION, writerQuiesced: false })).rejects.toMatchObject({ code: "canonical_backup_writer_not_quiesced" });
    await createCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: CANONICAL_BACKUP_AUTHORIZATION, writerQuiesced: true });
    await expect(createCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: CANONICAL_BACKUP_AUTHORIZATION, writerQuiesced: true })).rejects.toMatchObject({ code: "canonical_backup_output_exists" });
  });

  it("quarantines every interrupted backup and never writes a completion marker", async () => {
    const points = ["before-sqlite-snapshot", "after-sqlite-snapshot", "during-object-inventory", "during-object-streaming", "before-archive-finalization", "after-archive-finalization"] as const;
    for (const point of points) {
      const workspace = root(`prg32-backup-export-fault-${point}-`);
      const source = path.join(workspace, "source"); seed(source);
      const archive = path.join(workspace, "backup.zip");
      await expect(createCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: CANONICAL_BACKUP_AUTHORIZATION, writerQuiesced: true, fault: (actual) => { if (actual === point) throw new Error("fault"); } })).rejects.toThrow();
      expect(fs.existsSync(`${archive}.complete.json`)).toBe(false);
      if (fs.existsSync(archive)) expect(() => verifyCanonicalBackup(archive)).toThrow();
    }
  });

  it.each([
    ["truncated", (archive: string) => { const value = fs.readFileSync(archive); fs.writeFileSync(archive, value.subarray(0, value.length - 8)); }],
    ["corrupt-byte", (archive: string) => { const value = fs.readFileSync(archive); value[Math.floor(value.length / 2)] = (value[Math.floor(value.length / 2)] ?? 0) ^ 0xff; fs.writeFileSync(archive, value); }]
  ])("rejects %s archives before restore", async (_name, mutate) => {
    const workspace = root("prg32-backup-adversarial-");
    const source = path.join(workspace, "source"); seed(source);
    const archive = path.join(workspace, "backup.zip");
    await createCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: CANONICAL_BACKUP_AUTHORIZATION, writerQuiesced: true });
    mutate(archive);
    expect(() => verifyCanonicalBackup(archive)).toThrow();
    await expect(Promise.resolve().then(() => restoreCanonicalBackup({ archivePath: archive, targetRoot: path.join(workspace, "restore"), authorization: CANONICAL_BACKUP_AUTHORIZATION }))).rejects.toThrow();
  });

  it("rejects unsafe members, unexpected members, missing files, and archive limits", () => {
    const workspace = root("prg32-backup-members-");
    const cases = [
      { name: "missing manifest", entries: { "database.sqlite": Buffer.from("not sqlite") } },
      { name: "unexpected", entries: { "manifest.json": Buffer.from("{}"), "database.sqlite": Buffer.from("x"), "data/extra": Buffer.from("x"), "unexpected.txt": Buffer.from("x") } },
      { name: "traversal", entries: { "../escape": Buffer.from("x") } },
      { name: "absolute", entries: { "/absolute": Buffer.from("x") } }
    ];
    for (const item of cases) {
      const archive = path.join(workspace, `${item.name.replaceAll(" ", "-")}.zip`);
      fs.writeFileSync(archive, createZip(item.entries));
      expect(() => verifyCanonicalBackup(archive)).toThrow();
    }
    const archive = path.join(workspace, "size.zip");
    fs.writeFileSync(archive, createZip({ "manifest.json": Buffer.from("{}"), "database.sqlite": Buffer.from("x") }));
    expect(() => verifyCanonicalBackup(archive, { limits: { maxArchiveBytes: 1 } })).toThrow();
  });

  it("leaves a non-ready target for every deterministic restore interruption", async () => {
    const points = ["before-target-initialization", "after-sqlite-restore", "during-object-extraction", "during-staging-restoration", "during-journal-restoration", "before-final-integrity-verification", "after-verification-before-completion"] as const;
    for (const point of points) {
      const workspace = root(`prg32-backup-fault-${point}-`);
      const source = path.join(workspace, "source"); seed(source);
      const archive = path.join(workspace, "backup.zip");
      await createCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: CANONICAL_BACKUP_AUTHORIZATION, writerQuiesced: true });
      const target = path.join(workspace, "target");
      expect(() => restoreCanonicalBackup({ archivePath: archive, targetRoot: target, authorization: CANONICAL_BACKUP_AUTHORIZATION, fault: (actual) => { if (actual === point) throw new Error("fault"); } })).toThrow();
      if (point === "before-target-initialization") {
        expect(fs.existsSync(target)).toBe(false);
      } else {
        expect(fs.existsSync(path.join(target, ".prg32-storage-v2-restore.json"))).toBe(true);
        const sqlite = new Database(path.join(target, "store.sqlite"), { readonly: true });
        expect((sqlite.prepare("SELECT state FROM storage_metadata WHERE singleton_id = 1").get() as { state: string }).state).not.toBe("ready");
        sqlite.close();
        expect(() => restoreCanonicalBackup({ archivePath: archive, targetRoot: target, authorization: CANONICAL_BACKUP_AUTHORIZATION })).toThrow();
      }
    }
  }, 15_000);

  it("rehearses rollback with a single-writer state machine and emits machine-readable evidence", () => {
    const result = runRollbackRehearsal({ sourceSnapshotUnchanged: true, inventoryVerified: true, migrationVerified: true, parityVerified: true, backupVerified: true, restoreVerified: true, failureDetected: true });
    expect(result.ok).toBe(true);
    expect(result.finalState).toBe("completed");
    expect(result.simultaneousWriterRejected).toBe(true);
    expect(result.events.map((event) => event.state)).toEqual([
      "legacy_authoritative", "target_prepared", "target_verified", "target_authoritative", "target_failed", "target_relinquished", "legacy_restored", "completed"
    ]);
    expect(() => assertNoSimultaneousWriters(true, true)).toThrow("simultaneous writers");
  });

  it("does not pretend a legacy restart recovers post-cutover canonical writes", () => {
    const assessment = assessPostCutoverRollback(["legacy-1"], ["legacy-1", "canonical-1"], "reconcile_forward");
    expect(assessment).toMatchObject({ status: "LOSSLESS_ROLLBACK_NOT_AVAILABLE", losslessRollback: false, requiresExplicitReconciliation: true });
    expect(assessment.missingFromLegacySnapshot).toEqual(["canonical-1"]);
  });
});
