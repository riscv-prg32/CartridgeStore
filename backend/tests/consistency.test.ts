import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { PublicationConsistencyService } from "../src/consistency/publication.js";
import { buildSubmissionCartridge, parseCartridge } from "../src/submission/prg32.js";

const temporaryDirectories: string[] = [];
const PNG = Buffer.from("\x89PNG\r\n\x1a\n", "binary");

function fakeLegacyCartridge(): Buffer {
  const output = Buffer.alloc(72 + 12);
  output.write("PRG2", 0, "ascii");
  output.writeUInt16LE(1, 4);
  output.writeUInt16LE(72, 8);
  output.writeUInt32LE(12, 16);
  Buffer.from("\x13\x00\x00\x00\x13\x00\x00\x00\x13\x00\x00\x00", "binary").copy(output, 72);
  return output;
}

function cartridge(id = "org.example.consistency", version = "1.0.0", title = "Consistency Fixture"): Buffer {
  return Buffer.from(buildSubmissionCartridge(fakeLegacyCartridge(), {
    abi: "prg32-metadata-1.0",
    id,
    title,
    version,
    authors: [{ name: "PRG32" }],
    tags: ["test"],
    assets: { icon: "icon.png" }
  }, PNG, "qemu", null, null));
}

function fixture(): { root: string; database: Database.Database } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52a-consistency-"));
  temporaryDirectories.push(directory);
  const root = path.join(directory, "store");
  fs.mkdirSync(path.join(root, "pending", "1"), { recursive: true });
  const database = new Database(path.join(directory, "auth.sqlite"));
  database.exec(`
    CREATE TABLE cartridge_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pending_dir TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL,
      architectures_json TEXT NOT NULL,
      reviewed_by TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT
    );
  `);
  const metadata = { abi: "prg32-metadata-1.0", id: "org.example.consistency", title: "Consistency Fixture", version: "1.0.0", authors: [{ name: "PRG32" }], tags: ["test"], assets: { icon: "icon.png" } };
  database.prepare("INSERT INTO cartridge_submissions(game_id, version, pending_dir, metadata_json, architectures_json) VALUES (?, ?, ?, ?, ?)").run(
    "org.example.consistency",
    "1.0.0",
    "pending/1",
    JSON.stringify(metadata),
    JSON.stringify([{ architecture: "qemu", file: "game-qemu.prg32", stored: "pending/1/qemu.prg32" }])
  );
  fs.writeFileSync(path.join(root, "pending", "1", "qemu.prg32"), cartridge());
  return { root, database };
}

function insertPending(database: Database.Database, root: string, id: number, gameId: string, version: string, includeFile: boolean, title = "Consistency Fixture"): void {
  const pendingDirectory = path.join(root, "pending", String(id));
  if (includeFile) {
    fs.mkdirSync(pendingDirectory, { recursive: true });
    fs.writeFileSync(path.join(pendingDirectory, "qemu.prg32"), cartridge(gameId, version, title));
  }
  const metadata = { abi: "prg32-metadata-1.0", id: gameId, title: "Consistency Fixture", version, authors: [{ name: "PRG32" }], tags: ["test"], assets: { icon: "icon.png" } };
  database.prepare("INSERT INTO cartridge_submissions(id, game_id, version, pending_dir, metadata_json, architectures_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    gameId,
    version,
    `pending/${id}`,
    JSON.stringify(metadata),
    JSON.stringify([{ architecture: "qemu", file: "game-qemu.prg32", stored: `pending/${id}/qemu.prg32` }])
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("disposable publication consistency", () => {
  it("publishes valid pending artifacts and reports a clean fresh-process state", () => {
    const { root, database } = fixture();
    const service = new PublicationConsistencyService({ root, database });
    const operation = service.prepare(1);
    expect(operation.state).toBe("PREPARED");
    expect(service.execute(operation.operationId).state).toBe("COMPLETED");
    expect(fs.existsSync(path.join(root, "cartridges/org.example.consistency/1.0.0/qemu.prg32"))).toBe(true);
    expect((database.prepare("SELECT status FROM cartridge_submissions WHERE id = 1").get() as { status: string }).status).toBe("verified");
    expect(new PublicationConsistencyService({ root, database }).reconcile().status).toBe("CONSISTENT");
    database.close();
  });

  it("finds missing variants and orphaned pending directories without modifying them", () => {
    const { root, database } = fixture();
    const service = new PublicationConsistencyService({ root, database });
    const operation = service.prepare(1);
    service.execute(operation.operationId);
    insertPending(database, root, 2, "org.example.missing", "1.0.0", false);
    fs.mkdirSync(path.join(root, "pending", "999"), { recursive: true });
    const report = service.reconcile();
    expect(report.status).toBe("AMBIGUOUS");
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["PENDING_ROW_WITHOUT_DIRECTORY", "MISSING_PENDING_VARIANT", "ORPHAN_PENDING_DIRECTORY"]));
    expect(fs.existsSync(path.join(root, "pending", "999"))).toBe(true);
    database.close();
  });

  it("refuses a changed published artifact and surfaces the hash mismatch", () => {
    const { root, database } = fixture();
    const service = new PublicationConsistencyService({ root, database });
    const operation = service.prepare(1);
    service.execute(operation.operationId);
    fs.writeFileSync(path.join(root, "cartridges/org.example.consistency/1.0.0/qemu.prg32"), Buffer.from("changed"));
    const report = service.reconcile();
    expect(report.status).toBe("CORRUPT");
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PUBLISHED_HASH_MISMATCH" })]));
    database.close();
  });

  it("characterizes a missing pending artifact before creating a journal operation", () => {
    const { root, database } = fixture();
    fs.rmSync(path.join(root, "pending/1/qemu.prg32"));
    const service = new PublicationConsistencyService({ root, database });
    expect(() => service.prepare(1)).toThrow("pending cartridge file is missing");
    expect(service.listOperations()).toHaveLength(0);
    expect((database.prepare("SELECT status FROM cartridge_submissions WHERE id = 1").get() as { status: string }).status).toBe("pending");
    database.close();
  });

  it("restores backed-up files and index when compensation follows a replacement", () => {
    const { root, database } = fixture();
    const initialService = new PublicationConsistencyService({ root, database });
    initialService.execute(initialService.prepare(1).operationId);
    const targetPath = path.join(root, "cartridges/org.example.consistency/1.0.0/qemu.prg32");
    const indexPath = path.join(root, "index.json");
    const previousTarget = fs.readFileSync(targetPath);
    const previousIndex = fs.readFileSync(indexPath);
    insertPending(database, root, 2, "org.example.consistency", "1.0.0", true, "Replacement Fixture");
    let faulted = false;
    const service = new PublicationConsistencyService({ root, database, fault: (point) => {
      if (point === "after-database-update" && !faulted) { faulted = true; throw new Error("synthetic interruption"); }
    } });
    const operation = service.prepare(2);
    expect(() => service.execute(operation.operationId)).toThrow("synthetic interruption");
    const backupPath = path.join(root, "publication-backups", operation.operationId, "cartridges/org.example.consistency/1.0.0/qemu.prg32");
    const indexBackupPath = path.join(root, "publication-backups", operation.operationId, "index.json");
    expect(fs.readFileSync(backupPath)).toEqual(previousTarget);
    expect(fs.readFileSync(indexBackupPath)).toEqual(previousIndex);
    expect(service.recover(operation.operationId, "compensate").state).toBe("COMPENSATED");
    expect(fs.readFileSync(targetPath)).toEqual(previousTarget);
    expect(fs.readFileSync(indexPath)).toEqual(previousIndex);
    expect((database.prepare("SELECT status FROM cartridge_submissions WHERE id = 2").get() as { status: string }).status).toBe("pending");
    database.close();
  });

  it("characterizes compensation after a filesystem replacement interruption", () => {
    const { root, database } = fixture();
    const initialService = new PublicationConsistencyService({ root, database });
    initialService.execute(initialService.prepare(1).operationId);
    const targetPath = path.join(root, "cartridges/org.example.consistency/1.0.0/qemu.prg32");
    const previousTarget = fs.readFileSync(targetPath);
    insertPending(database, root, 2, "org.example.consistency", "1.0.0", true, "Replacement Fixture");
    let interrupted = false;
    const service = new PublicationConsistencyService({ root, database, fault: (point) => {
      if (point === "after-binary-replacement" && !interrupted) { interrupted = true; throw new Error("filesystem interruption"); }
    } });
    const operation = service.prepare(2);
    expect(() => service.execute(operation.operationId)).toThrow("filesystem interruption");
    expect(service.recover(operation.operationId, "compensate").state).toBe("COMPENSATED");
    expect(fs.readFileSync(targetPath)).toEqual(previousTarget);
    expect((database.prepare("SELECT status FROM cartridge_submissions WHERE id = 2").get() as { status: string }).status).toBe("pending");
    database.close();
  });

  it("recovers after an actual process termination between index replacement and journal transition", async () => {
    const { root, database } = fixture();
    database.close();
    const child = spawnSync(process.execPath, ["--import", "tsx", path.resolve("tests/fixtures/kill-publication.ts")], {
      cwd: process.cwd(),
      env: { ...process.env, PRG32_TEST_ROOT: root, PRG32_TEST_DATABASE: path.join(path.dirname(root), "auth.sqlite"), PRG32_TEST_KILL_POINT: "after-index-replacement" },
      stdio: "ignore"
    });
    expect(child.signal).toBe("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const freshDatabase = new Database(path.join(path.dirname(root), "auth.sqlite"));
    const freshService = new PublicationConsistencyService({ root, database: freshDatabase });
    const operations = freshService.listOperations();
    expect(operations).toHaveLength(1);
    expect(freshService.reconcile().status).toBe("RECOVERABLE");
    expect(freshService.recover(operations[0]!.operationId, "resume").state).toBe("COMPLETED");
    expect(freshService.reconcile().status).toBe("CONSISTENT");
    freshDatabase.close();
  }, 10000);

  it("updates and deletes published catalog variants through the same journal with recovery", () => {
    const { root, database } = fixture();
    const service = new PublicationConsistencyService({ root, database });
    service.execute(service.prepare(1).operationId);
    const target = path.join(root, "cartridges/org.example.consistency/1.0.0/qemu.prg32");
    const updated = service.mutateCatalog({ gameId: "org.example.consistency", version: "1.0.0", metadata: { title: "Catalog Updated", tags: ["admin"] } });
    expect(updated.state).toBe("COMPLETED");
    expect(parseCartridge(fs.readFileSync(target)).metadata).toMatchObject({ title: "Catalog Updated", tags: ["admin"] });

    let interrupted = false;
    const recovering = new PublicationConsistencyService({ root, database, fault: (point) => {
      if (point === "after-index-replacement" && !interrupted) { interrupted = true; throw new Error("catalog interruption"); }
    } });
    const deletion = recovering.prepareCatalog({ gameId: "org.example.consistency", version: "1.0.0" });
    expect(() => recovering.execute(deletion.operationId)).toThrow("catalog interruption");
    expect(recovering.recover(deletion.operationId, "resume").state).toBe("COMPLETED");
    expect(fs.existsSync(target)).toBe(false);
    expect(recovering.reconcile().status).toBe("CONSISTENT");
    database.close();
  });
});
