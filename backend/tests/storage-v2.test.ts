import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  ObjectStore,
  StorageDatabaseError,
  StorageObjectError,
  StorageRelationshipError,
  StorageRelationshipService,
  StagingStore,
  auditStorage,
  initializeDisposableStorage,
  openTargetStorage
} from "../src/storage-v2/index.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-storage-v2-"));
  roots.push(root);
  return root;
}

function seedRelease(database: Database.Database, releaseId = "rel_fixture"): void {
  database.prepare(
    "INSERT INTO cartridges(cartridge_id, created_at, updated_at) VALUES ('fixture-game', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
  ).run();
  database.prepare(
    `INSERT INTO releases(release_id, cartridge_id, version, revision, state, title, metadata_json, created_at)
     VALUES (?, 'fixture-game', '1.0.0', 1, 'draft', 'Fixture Game', '{}', '2026-01-01T00:00:00.000Z')`
  ).run(releaseId);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical SQLite schema", () => {
  it("initializes a complete target schema and version tuple from an empty disposable root", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    const tables = new Set(
      (resource.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
    );
    for (const table of [
      "users", "groups", "user_groups", "api_tokens", "registration_tokens", "store_settings", "scores", "runs", "samples",
      "storage_metadata", "schema_migrations", "cartridges", "releases", "storage_objects", "artifacts", "media", "site_assets",
      "submissions", "submission_artifacts", "review_decisions", "publication_operations", "publication_operation_items", "publication_events", "download_events", "migration_exceptions"
    ]) expect(tables.has(table)).toBe(true);
    expect(resource.sqlite.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(resource.sqlite.prepare("SELECT * FROM storage_metadata").get()).toMatchObject({
      application: "prg32-cartridge-store",
      schema_version: 2,
      storage_layout_version: 2,
      publication_journal_version: 1,
      backup_format_version: 3,
      state: "ready"
    });
    expect(resource.sqlite.prepare("SELECT state FROM schema_migrations WHERE component = 'storage-v2'").get()).toEqual({ state: "applied" });
    for (const relative of [
      "storage/objects/artifacts", "storage/objects/media", "storage/objects/site-assets", "storage/objects/.tmp",
      "storage/staging/submissions", "storage/staging/operations", "storage/quarantine", "journal/publications", "backups", "compatibility"
    ]) expect(fs.statSync(path.join(resource.paths.root, relative)).isDirectory()).toBe(true);
    resource.close();
  });

  it("keeps physical object metadata only on storage_objects", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    for (const table of ["artifacts", "media", "site_assets"]) {
      const columns = (resource.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).not.toContain("sha256");
      expect(columns).not.toContain("size_bytes");
      expect(columns).not.toContain("media_type");
    }
    const objectColumns = (resource.sqlite.prepare("PRAGMA table_info(storage_objects)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(objectColumns).toEqual(expect.arrayContaining(["storage_key", "sha256", "size_bytes", "media_type"]));
    resource.close();
  });

  it("allows four media objects in one publication operation and rejects a repeated physical object", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    seedRelease(resource.sqlite);
    resource.sqlite.prepare(
      `INSERT INTO publication_operations(operation_id, operation_kind, release_id, state, manifest_json, created_at, updated_at)
       VALUES ('op_fixture', 'catalog', 'rel_fixture', 'prepared', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    ).run();
    const store = new ObjectStore(resource.sqlite, resource.paths);
    const relationships = new StorageRelationshipService(resource.sqlite);
    const media = [
      ["esp32c6", "icon"], ["esp32c6", "screenshot"], ["qemu", "icon"], ["qemu", "screenshot"]
    ] as const;
    for (const [architecture, role] of media) {
      const object = store.store("media", Buffer.from(`${architecture}-${role}`), "image/png");
      relationships.createPublicationItem({
        operationId: "op_fixture",
        itemKind: "media",
        architecture,
        targetRole: role,
        expectedObjectId: object.objectId,
        targetStorageKey: object.storageKey,
        expectedSha256: object.sha256,
        expectedSizeBytes: object.sizeBytes
      });
    }
    expect(resource.sqlite.prepare("SELECT COUNT(*) AS count FROM publication_operation_items").get()).toEqual({ count: 4 });
    const first = resource.sqlite.prepare("SELECT * FROM storage_objects LIMIT 1").get() as { object_id: string; sha256: string; size_bytes: number; storage_key: string };
    expect(() => relationships.createPublicationItem({
      operationId: "op_fixture",
      itemKind: "media",
      architecture: "esp32c6",
      targetRole: "icon",
      expectedObjectId: first.object_id,
      targetStorageKey: first.storage_key,
      expectedSha256: first.sha256,
      expectedSizeBytes: first.size_bytes
    })).toThrow(StorageRelationshipError);
    resource.close();
  });

  it("rejects object-kind mismatches at the relationship service", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    seedRelease(resource.sqlite);
    const store = new ObjectStore(resource.sqlite, resource.paths);
    const object = store.store("artifact", Buffer.from("PRG32 fixture"), "application/vnd.prg32.cartridge");
    const relationships = new StorageRelationshipService(resource.sqlite);
    expect(() => relationships.createMedia({ releaseId: "rel_fixture", architecture: "qemu", kind: "icon", objectId: object.objectId })).toThrow("kind");
    resource.close();
  });

  it("stages bounded submission bytes under a generated architecture path without creating a DB row", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    const staged = new StagingStore(resource.paths).stageSubmissionArtifact(
      7,
      "esp32c6",
      "publisher-upload.prg32",
      Buffer.from("staged firmware bytes")
    );
    expect(staged.stagingKey).toBe("storage/staging/submissions/7/artifacts/esp32c6.prg32");
    expect(fs.readFileSync(path.join(resource.paths.root, staged.stagingKey))).toEqual(Buffer.from("staged firmware bytes"));
    expect(resource.sqlite.prepare("SELECT COUNT(*) AS count FROM submission_artifacts").get()).toEqual({ count: 0 });
    expect(() => new StagingStore(resource.paths).stageSubmissionArtifact(7, "esp32c6", "second.prg32", Buffer.from("duplicate"))).toThrow("exists");
    expect(() => new StagingStore(resource.paths).stageSubmissionArtifact(8, "qemu", "../escape.prg32", Buffer.from("bad"))).toThrow("filename");
    resource.close();
  });
});

describe("immutable object storage", () => {
  it("stores, resolves, verifies, and never overwrites an immutable object", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    const store = new ObjectStore(resource.sqlite, resource.paths);
    const bytes = Buffer.from("deterministic PRG32 object bytes");
    const object = store.store("artifact", bytes, "application/vnd.prg32.cartridge", { objectId: "obj_0123456789abcdef" });
    expect(object.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    expect(fs.readFileSync(path.join(resource.paths.root, object.storageKey))).toEqual(bytes);
    const resolved = store.resolve(object.objectId, "artifact");
    expect(fs.readFileSync(resolved.filePath)).toEqual(bytes);
    fs.closeSync(resolved.fileDescriptor);
    expect(store.verify(object.objectId)).toMatchObject({ ok: true, code: "ok", actualSizeBytes: bytes.byteLength });
    expect(() => store.store("artifact", Buffer.from("replacement"), "application/vnd.prg32.cartridge", { objectId: object.objectId })).toThrow(StorageObjectError);
    expect(fs.readFileSync(path.join(resource.paths.root, object.storageKey))).toEqual(bytes);
    resource.close();
  });

  it("rejects invalid kinds, unsafe identifiers, and unsupported media types", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    const store = new ObjectStore(resource.sqlite, resource.paths);
    expect(() => store.store("unknown" as never, Buffer.from("x"), "image/png")).toThrow("kind");
    expect(() => store.store("media", Buffer.from("x"), "text/plain")).toThrow("media type");
    expect(() => store.store("media", Buffer.from("x"), "image/png", { objectId: "../escape" })).toThrow("identifier");
    expect(() => store.resolve("../escape")).toThrow("identifier");
    resource.close();
  });

  it("rejects a symlink destination and a tampered storage key", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    const store = new ObjectStore(resource.sqlite, resource.paths);
    const object = store.store("media", Buffer.from("image bytes"), "image/png");
    const target = path.join(resource.paths.root, object.storageKey);
    fs.rmSync(target);
    fs.symlinkSync(path.join(resource.paths.root, "outside"), target);
    expect(() => store.resolve(object.objectId)).toThrow("symlink");
    fs.rmSync(target);
    resource.sqlite.prepare("UPDATE storage_objects SET storage_key = '../../outside' WHERE object_id = ?").run(object.objectId);
    expect(() => store.resolve(object.objectId)).toThrow("key");
    resource.close();
  });
});

describe("read-only integrity audit", () => {
  it("detects missing files, hash mismatches, orphan files, and invalid relationships without mutation", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    seedRelease(resource.sqlite);
    const store = new ObjectStore(resource.sqlite, resource.paths);
    const object = store.store("artifact", Buffer.from("integrity bytes"), "application/vnd.prg32.cartridge");
    const relationships = new StorageRelationshipService(resource.sqlite);
    const artifactId = relationships.createArtifact({ releaseId: "rel_fixture", architecture: "qemu", objectId: object.objectId });
    fs.writeFileSync(path.join(resource.paths.artifactRoot, "orphan.prg32"), Buffer.from("orphan"));
    const beforeRow = resource.sqlite.prepare("SELECT * FROM storage_objects WHERE object_id = ?").get(object.objectId);
    fs.writeFileSync(path.join(resource.paths.root, object.storageKey), Buffer.alloc(object.sizeBytes, 0x7f));
    const report = auditStorage(resource.sqlite, resource.paths);
    expect(report.ok).toBe(false);
    expect(report.findings.map((item) => item.code)).toEqual(expect.arrayContaining(["object_hash_mismatch", "orphaned_object_file"]));
    expect(resource.sqlite.prepare("SELECT * FROM storage_objects WHERE object_id = ?").get(object.objectId)).toEqual(beforeRow);
    expect(resource.sqlite.prepare("SELECT artifact_id FROM artifacts WHERE artifact_id = ?").get(artifactId)).toEqual({ artifact_id: artifactId });
    resource.close();
  });

  it("reports symlinks and unavailable published objects", () => {
    const resource = initializeDisposableStorage(temporaryRoot());
    seedRelease(resource.sqlite);
    resource.sqlite.prepare("UPDATE releases SET state = 'published', published_at = '2026-01-01T00:00:00.000Z', published_order = 1 WHERE release_id = 'rel_fixture'").run();
    const store = new ObjectStore(resource.sqlite, resource.paths);
    const object = store.store("artifact", Buffer.from("published bytes"), "application/vnd.prg32.cartridge");
    resource.sqlite.prepare("INSERT INTO artifacts(artifact_id, release_id, architecture, object_id, state, created_at) VALUES ('artifact_fixture', 'rel_fixture', 'qemu', ?, 'published', '2026-01-01T00:00:00.000Z')").run(object.objectId);
    const target = path.join(resource.paths.root, object.storageKey);
    fs.rmSync(target);
    fs.symlinkSync(path.join(resource.paths.root, "missing-target"), target);
    const report = auditStorage(resource.sqlite, resource.paths);
    expect(() => store.resolve(object.objectId)).toThrow("symlink");
    expect(report.findings.map((item) => item.code)).toEqual(expect.arrayContaining(["symlinked_object", "object_symlink"]));
    resource.close();
  });
});

describe("disposable-root and failure safeguards", () => {
  it("refuses repository roots, symlink roots, and non-empty roots", () => {
    expect(() => initializeDisposableStorage(process.cwd())).toThrow(StorageDatabaseError);
    const nonEmpty = temporaryRoot();
    fs.writeFileSync(path.join(nonEmpty, "existing"), "do not touch");
    expect(() => initializeDisposableStorage(nonEmpty)).toThrow("empty");
    const target = temporaryRoot();
    const link = path.join(os.tmpdir(), `prg32-storage-v2-link-${crypto.randomUUID()}`);
    fs.symlinkSync(target, link, "dir");
    roots.push(link);
    expect(() => initializeDisposableStorage(link)).toThrow("symlink");
  });

  it("fails closed for version mismatch and incomplete initialization", () => {
    const root = temporaryRoot();
    const resource = initializeDisposableStorage(root);
    resource.close();
    const sqlite = new Database(path.join(root, "store.sqlite"));
    sqlite.prepare("UPDATE storage_metadata SET storage_layout_version = 99 WHERE singleton_id = 1").run();
    sqlite.close();
    expect(() => openTargetStorage(root)).toThrow("incompatible");

    const incomplete = temporaryRoot();
    const incompleteDb = new Database(path.join(incomplete, "store.sqlite"));
    incompleteDb.close();
    expect(() => openTargetStorage(incomplete)).toThrow();
  });

  it.each([
    "before-temporary-file",
    "during-write",
    "before-promotion",
    "after-promotion",
    "before-database-insert",
    "after-database-insert"
  ] as const)("does not expose an object as available when failure is injected at %s", (point) => {
    const resource = initializeDisposableStorage(temporaryRoot());
    const store = new ObjectStore(resource.sqlite, resource.paths);
    expect(() => store.store("media", Buffer.from("fault fixture"), "image/png", {
      fault: (current) => { if (current === point) throw new Error(`fault:${point}`); }
    })).toThrow();
    expect(resource.sqlite.prepare("SELECT COUNT(*) AS count FROM storage_objects WHERE state = 'available'").get()).toEqual({ count: 0 });
    resource.close();
  });
});
