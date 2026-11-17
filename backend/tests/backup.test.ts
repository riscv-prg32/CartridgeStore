import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { BackupService } from "../src/backup/service.js";
import { decryptBackup } from "../src/backup/archive.js";
import { SecretStore } from "../src/secrets/service.js";

const roots: string[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];
const BOOTSTRAP = "backup-bootstrap-token-1234567890";

function createDatabase(): { readonly root: string; readonly databasePath: string; readonly storeRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m63c2-"));
  roots.push(root);
  const storeRoot = path.join(root, "store");
  const authRoot = path.join(root, "auth-workspace");
  const databasePath = path.join(authRoot, "auth.sqlite");
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(authRoot);
  const db = new Database(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, target TEXT NOT NULL, display_backend TEXT NOT NULL DEFAULT '', firmware_version TEXT NOT NULL DEFAULT '', firmware_git_sha TEXT NOT NULL DEFAULT '', game_name TEXT NOT NULL DEFAULT '', sample_period_frames INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL, finished_at INTEGER, dropped_samples INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), submitted_by TEXT NOT NULL DEFAULT '', user_id INTEGER REFERENCES users(id));
    CREATE TABLE samples (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, frame INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, update_us INTEGER NOT NULL, draw_us INTEGER NOT NULL, present_us INTEGER NOT NULL, frame_us INTEGER NOT NULL, heap_free INTEGER NOT NULL, heap_min_free INTEGER NOT NULL, input_mask INTEGER NOT NULL, fps_x100 INTEGER NOT NULL, upload_queue_depth INTEGER NOT NULL, deadline_missed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), UNIQUE(run_id, frame));
    CREATE TABLE scores (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, player TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL DEFAULT '');
    CREATE TABLE download_events (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, architecture TEXT NOT NULL, user_id INTEGER, ip_hash TEXT, user_agent TEXT, downloaded_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE cartridge_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_by TEXT NOT NULL DEFAULT '', reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT NOT NULL DEFAULT '', pending_dir TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL, architectures_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT);
    CREATE INDEX samples_run_frame_idx ON samples(run_id, frame);
    CREATE INDEX samples_run_frame_time_idx ON samples(run_id, frame_us);
    CREATE INDEX scores_game_score_idx ON scores(game, score DESC, created_at ASC);
    CREATE INDEX download_events_game_idx ON download_events(game_id, downloaded_at);
    CREATE INDEX download_events_arch_idx ON download_events(architecture);
    CREATE INDEX cartridge_submissions_status_idx ON cartridge_submissions(status, created_at);
  `);
  db.close();
  fs.writeFileSync(path.join(storeRoot, "index.json"), JSON.stringify({
    abi: "prg32-cartridge-store-index-1.0",
    games: {
      "unicode-game": {
        id: "unicode-game",
        title: "Unicode Game",
        summary: "",
        authors: [],
        tags: [],
        latest_version: "1.0.0",
        versions: {
          "1.0.0": {
            metadata: { id: "unicode-game", version: "1.0.0" },
            colophon: null,
            architectures: {
              qemu: { filename: "cartridges/unicode-ゲーム/1.0.0/qemu.prg32", sha256: "" }
            }
          }
        }
      }
    }
  }, null, 2));
  const cartridge = path.join(storeRoot, "cartridges/unicode-ゲーム/1.0.0/qemu.prg32");
  fs.mkdirSync(path.dirname(cartridge), { recursive: true });
  fs.writeFileSync(cartridge, Buffer.from([0, 1, 2, 3, 4]));
  fs.mkdirSync(path.join(storeRoot, "pending/7"), { recursive: true });
  fs.writeFileSync(path.join(storeRoot, "pending/7/qemu.prg32"), Buffer.from([5, 6, 7]));
  return { root, databasePath, storeRoot };
}

function fixture(options: Record<string, string> = {}) {
  const paths = createDatabase();
  const shadow = path.join(paths.root, "shadow.sqlite");
  const authRoot = path.join(paths.root, "auth-workspace");
  fs.writeFileSync(shadow, Buffer.from("shadow"));
  const app = buildApp({
    config: loadConfig({
      PRG32_BACKEND_DB: shadow,
      PRG32_BACKEND_STORE_DATA: paths.storeRoot,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: paths.databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: authRoot,
      PRG32_BACKEND_SESSION_SECRET: "backup-session-secret-1234567890",
      PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
      PRG32_BACKEND_SESSION_SECURE: "false",
      PRG32_BACKEND_BACKUP_ENABLED: "true",
      PRG32_BACKEND_BACKUP_MODE: "test",
      ...options
    }),
    logger: false
  });
  apps.push(app);
  return { app, ...paths };
}

function header(response: { readonly headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function adminSession(app: ReturnType<typeof buildApp>): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const bootstrap = await app.inject({
    method: "POST",
    url: "/auth/bootstrap",
    headers: { "x-prg32-bootstrap-token": BOOTSTRAP },
    payload: { username: "backup-admin", email: "backup-admin@example.test", password: "long-password-123", password_confirm: "long-password-123" }
  });
  const cookie = header(bootstrap, "set-cookie").split(";", 1)[0] ?? "";
  const csrfResponse = await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie } });
  return { cookie, csrf: csrfResponse.json<{ csrf_token: string }>().csrf_token };
}

function multipart(bytes: Uint8Array, csrf: string, password = ""): { readonly body: Buffer; readonly contentType: string } {
  const boundary = "----prg32-m63c2-boundary";
  const parts = [
    Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"csrf_token\"\r\n\r\n" + csrf + "\r\n"),
    ...(password ? [Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"backup_password\"\r\n\r\n" + password + "\r\n")] : []),
    Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"backup\"; filename=\"backup.zip\"\r\nContent-Type: application/zip\r\n\r\n"),
    Buffer.from(bytes),
    Buffer.from("\r\n--" + boundary + "--\r\n")
  ];
  return { body: Buffer.concat(parts), contentType: "multipart/form-data; boundary=" + boundary };
}

async function exportArchive(app: ReturnType<typeof buildApp>, auth: { readonly cookie: string }, password = "") {
  const response = await app.inject({
    method: "GET",
    url: "/admin/backup/download",
    headers: { cookie: auth.cookie, ...(password ? { "x-prg32-backup-password": password } : {}) }
  });
  expect(response.statusCode).toBe(200);
  return response;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("application backup", () => {
  it("is disabled by default", async () => {
    const paths = createDatabase();
    const shadow = path.join(paths.root, "shadow.sqlite");
    fs.writeFileSync(shadow, Buffer.from("shadow"));
    const app = buildApp({
      config: loadConfig({ PRG32_BACKEND_DB: shadow, PRG32_BACKEND_STORE_DATA: paths.storeRoot }),
      logger: false
    });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/admin/backup/download" })).statusCode).toBe(404);
  });

  it("requires an encrypted administrative export when secret encryption is enabled and records safe key metadata", async () => {
    const paths = createDatabase();
    const keyPath = path.join(paths.root, "keys.json");
    fs.writeFileSync(keyPath, JSON.stringify({ version: 1, active_key_id: "backup-key", keys: [{ id: "backup-key", status: "active", key: Buffer.alloc(32, 9).toString("base64url") }] }) + "\n", { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    const db = new Database(paths.databasePath);
    db.prepare("INSERT INTO store_settings(key, value) VALUES (?, ?)").run("smtp_password", "backup-secret");
    const secrets = new SecretStore({ keyRegistryPath: keyPath, applicationDataRoot: paths.storeRoot });
    secrets.migrate(db, paths.databasePath, { confirm: true, snapshotPath: path.join(paths.root, "migration.snapshot.json") });
    db.close();
    const shadow = path.join(paths.root, "shadow.sqlite");
    fs.writeFileSync(shadow, Buffer.from("shadow"));
    const config = loadConfig({
      PRG32_BACKEND_DB: shadow,
      PRG32_BACKEND_STORE_DATA: paths.storeRoot,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: paths.databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.join(paths.root, "auth-workspace"),
      PRG32_BACKEND_SESSION_SECRET: "backup-secret-session-1234567890",
      PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
      PRG32_BACKEND_SESSION_SECURE: "false",
      PRG32_BACKEND_BACKUP_ENABLED: "true",
      PRG32_BACKEND_BACKUP_MODE: "test",
      PRG32_BACKEND_SECRET_ENCRYPTION_ENABLED: "true",
      PRG32_BACKEND_SECRET_KEY_REGISTRY: keyPath
    });
    const app = buildApp({ config, logger: false });
    apps.push(app);
    const auth = await adminSession(app);
    const plaintext = await app.inject({ method: "GET", url: "/admin/backup/download", headers: { cookie: auth.cookie } });
    expect(plaintext.statusCode).toBe(400);
    expect(plaintext.json()).toMatchObject({ code: "backup_encryption_required" });
    const exported = await app.inject({ method: "GET", url: "/admin/backup/download", headers: { cookie: auth.cookie, "x-prg32-backup-password": "backup-password" } });
    expect(exported.statusCode).toBe(200);
    expect(header(exported, "content-type")).toContain("application/octet-stream");
    expect(exported.rawPayload.toString("utf8")).not.toContain("backup-secret");
    const encryptedPath = path.join(paths.root, "backup.enc");
    const zipPath = path.join(paths.root, "backup.zip");
    fs.writeFileSync(encryptedPath, exported.rawPayload, { mode: 0o600 });
    decryptBackup(encryptedPath, zipPath, "backup-password");
    const entries = unzipSync(fs.readFileSync(zipPath));
    const manifest = JSON.parse(Buffer.from(entries["manifest.json"] as Uint8Array).toString("utf8")) as Record<string, unknown>;
    expect(manifest.secret_encryption).toMatchObject({ envelope_version: 1, required_key_ids: ["backup-key"], encrypted_settings: 1 });
    expect(Buffer.from(entries["database.sqlite"] as Uint8Array).toString("utf8")).not.toContain("backup-secret");
  });

  it("exports v2 with inventory, preserves Unicode data, and imports legacy v1", async () => {
    const test = fixture();
    const auth = await adminSession(test.app);
    const exported = await exportArchive(test.app, auth);
    expect(header(exported, "content-type")).toContain("application/zip");
    expect(header(exported, "content-disposition")).toContain("prg32-cartridge-store-backup-v2.zip");
    const entries = unzipSync(exported.rawPayload);
    const manifest = JSON.parse(Buffer.from(entries["manifest.json"] as Uint8Array).toString("utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ abi: "prg32-cartridge-store-backup-2.0", format_version: 2, database: "database.sqlite", data_dir: "data/" });
    expect(entries["data/cartridges/unicode-ゲーム/1.0.0/qemu.prg32"]).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
    expect(entries["data/pending/7/qemu.prg32"]).toEqual(new Uint8Array([5, 6, 7]));

    const legacyEntries = { ...entries, "manifest.json": Buffer.from(JSON.stringify({ abi: "prg32-cartridge-store-backup-1.0", database: "database.sqlite", data_dir: "data/" })) };
    const legacy = zipSync(legacyEntries);
    fs.rmSync(path.join(test.storeRoot, "cartridges"), { recursive: true, force: true });
    const restore = await test.app.inject({
      method: "POST",
      url: "/admin/backup/restore",
      headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf, "content-type": multipart(legacy, auth.csrf).contentType },
      payload: multipart(legacy, auth.csrf).body
    });
    expect(restore.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(test.storeRoot, "cartridges/unicode-ゲーム/1.0.0/qemu.prg32"))).toEqual(Buffer.from([0, 1, 2, 3, 4]));
    const restoredDb = new Database(test.databasePath, { readonly: true });
    expect((restoredDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    restoredDb.close();
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { cookie: auth.cookie } })).statusCode).toBe(401);

    const other = fixture();
    const otherAuth = await adminSession(other.app);
    const portable = multipart(exported.rawPayload, otherAuth.csrf);
    const portableRestore = await other.app.inject({
      method: "POST",
      url: "/admin/backup/restore",
      headers: { cookie: otherAuth.cookie, "content-type": portable.contentType },
      payload: portable.body
    });
    expect(portableRestore.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(other.storeRoot, "cartridges/unicode-ゲーム/1.0.0/qemu.prg32"))).toEqual(Buffer.from([0, 1, 2, 3, 4]));
  });

  it("supports portable password-protected export and rejects wrong or tampered passwords", async () => {
    const test = fixture();
    const auth = await adminSession(test.app);
    const exported = await exportArchive(test.app, auth, "portable-password");
    expect(header(exported, "content-type")).toContain("application/octet-stream");
    const wrong = multipart(exported.rawPayload, auth.csrf, "wrong-password");
    const wrongResponse = await test.app.inject({ method: "POST", url: "/admin/backup/restore", headers: { cookie: auth.cookie, "content-type": wrong.contentType }, payload: wrong.body });
    expect(wrongResponse.statusCode).toBe(400);
    expect(wrongResponse.json()).toMatchObject({ code: "backup_decryption_failed" });
    const tampered = Buffer.from(exported.rawPayload);
    tampered[tampered.length - 1] ^= 1;
    const tamperedPayload = multipart(tampered, auth.csrf, "portable-password");
    const tamperedResponse = await test.app.inject({ method: "POST", url: "/admin/backup/restore", headers: { cookie: auth.cookie, "content-type": tamperedPayload.contentType }, payload: tamperedPayload.body });
    expect(tamperedResponse.statusCode).toBe(400);
    const valid = multipart(exported.rawPayload, auth.csrf, "portable-password");
    const validResponse = await test.app.inject({ method: "POST", url: "/admin/backup/restore", headers: { cookie: auth.cookie, "content-type": valid.contentType }, payload: valid.body });
    expect(validResponse.statusCode).toBe(200);
  });

  it("rejects bearer-only restore, CSRF failures, and unsafe archives", async () => {
    const test = fixture();
    const auth = await adminSession(test.app);
    const exported = await exportArchive(test.app, auth);
    const db = new Database(test.databasePath);
    const token = "prg32_backup_admin_token";
    db.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(1, hashApiToken(token), "test");
    db.close();
    const bearerPayload = multipart(exported.rawPayload, "");
    const bearer = await test.app.inject({ method: "POST", url: "/admin/backup/restore", headers: { authorization: "Bearer " + token, "content-type": bearerPayload.contentType }, payload: bearerPayload.body });
    expect(bearer.statusCode).toBe(403);
    expect(bearer.json()).toMatchObject({ code: "backup_bearer_restore_disabled" });

    const noCsrf = multipart(exported.rawPayload, "");
    const csrf = await test.app.inject({ method: "POST", url: "/admin/backup/restore", headers: { cookie: auth.cookie, "content-type": noCsrf.contentType }, payload: noCsrf.body });
    expect(csrf.statusCode).toBe(403);
    expect(csrf.json()).toMatchObject({ code: "csrf_failed" });

    const unsafe = zipSync({
      "manifest.json": Buffer.from(JSON.stringify({ abi: "prg32-cartridge-store-backup-1.0", database: "database.sqlite", data_dir: "data/" })),
      "database.sqlite": Buffer.from("not-a-database"),
      "../escape.txt": Buffer.from("unsafe")
    });
    const unsafePayload = multipart(unsafe, auth.csrf);
    const unsafeResponse = await test.app.inject({ method: "POST", url: "/admin/backup/restore", headers: { cookie: auth.cookie, "content-type": unsafePayload.contentType }, payload: unsafePayload.body });
    expect(unsafeResponse.statusCode).toBe(400);
    expect(unsafeResponse.json()).toMatchObject({ code: "backup_unsafe_path" });
  });

  it("rejects missing manifests, corrupt databases, missing files, and unsupported compression", async () => {
    const test = fixture();
    const auth = await adminSession(test.app);
    const exported = await exportArchive(test.app, auth);
    const entries = unzipSync(exported.rawPayload);
    const legacyManifest = Buffer.from(JSON.stringify({ abi: "prg32-cartridge-store-backup-1.0", database: "database.sqlite", data_dir: "data/" }));
    const upload = async (bytes: Uint8Array) => {
      const payload = multipart(bytes, auth.csrf);
      return test.app.inject({ method: "POST", url: "/admin/backup/restore", headers: { cookie: auth.cookie, "content-type": payload.contentType }, payload: payload.body });
    };
    const withoutManifest = { ...entries };
    delete withoutManifest["manifest.json"];
    expect((await upload(zipSync(withoutManifest))).json()).toMatchObject({ code: "backup_required_file_missing" });
    expect((await upload(zipSync({ ...entries, "manifest.json": legacyManifest, "database.sqlite": Buffer.from("not-sqlite") }))).json()).toMatchObject({ code: "backup_validation_failed" });
    const withoutCartridge = { ...entries, "manifest.json": legacyManifest };
    delete withoutCartridge["data/cartridges/unicode-ゲーム/1.0.0/qemu.prg32"];
    expect((await upload(zipSync(withoutCartridge))).json()).toMatchObject({ code: "backup_filesystem_invalid" });
    const unsupported = Buffer.from(zipSync({ ...entries, "manifest.json": legacyManifest }));
    for (let index = 0; index + 4 <= unsupported.length; index += 1) {
      const signature = unsupported.readUInt32LE(index);
      if (signature === 0x04034b50) unsupported.writeUInt16LE(99, index + 8);
      if (signature === 0x02014b50) unsupported.writeUInt16LE(99, index + 10);
    }
    expect((await upload(unsupported)).json()).toMatchObject({ code: "backup_archive_unsupported" });
    const duplicate = zipSync({
      "manifest.json": legacyManifest,
      "database.sqlite": entries["database.sqlite"],
      "data/duplicate": Buffer.from("one"),
      "data\\duplicate": Buffer.from("two")
    });
    expect((await upload(duplicate)).json()).toMatchObject({ code: "backup_duplicate_entry" });
    const symlink = Buffer.from(zipSync({ "manifest.json": legacyManifest, "database.sqlite": entries["database.sqlite"], "data/link": Buffer.from("link") }));
    for (let index = 0; index + 4 <= symlink.length; index += 1) {
      if (symlink.readUInt32LE(index) === 0x02014b50) {
        symlink.writeUInt16LE(0x0314, index + 4);
        symlink.writeUInt32LE((0xa000 | 0o777) * 65536, index + 38);
      }
    }
    expect((await upload(symlink)).json()).toMatchObject({ code: "backup_unsupported_file_type" });
  });

  it("characterizes validation-before-mutation for an archive with an inventory mismatch", async () => {
    const test = fixture();
    const auth = await adminSession(test.app);
    const exported = await exportArchive(test.app, auth);
    const entries = unzipSync(exported.rawPayload);
    delete entries["data/cartridges/unicode-ゲーム/1.0.0/qemu.prg32"];
    const payload = multipart(zipSync(entries), auth.csrf);
    const response = await test.app.inject({
      method: "POST",
      url: "/admin/backup/restore",
      headers: { cookie: auth.cookie, "content-type": payload.contentType },
      payload: payload.body
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "backup_inventory_mismatch" });
    expect(fs.readFileSync(path.join(test.storeRoot, "cartridges/unicode-ゲーム/1.0.0/qemu.prg32"))).toEqual(Buffer.from([0, 1, 2, 3, 4]));
    const database = new Database(test.databasePath, { readonly: true });
    expect((database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    database.close();
  });

  it("rolls back a failed post-filesystem restore", async () => {
    const test = createDatabase();
    const db = new Database(test.databasePath);
    const config = loadConfig({
      PRG32_BACKEND_DB: path.join(test.root, "shadow.sqlite"),
      PRG32_BACKEND_STORE_DATA: test.storeRoot,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: test.databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.join(test.root, "auth-workspace"),
      PRG32_BACKEND_BACKUP_ENABLED: "true",
      PRG32_BACKEND_BACKUP_MODE: "test",
      PRG32_BACKEND_SESSION_SECRET: "backup-session-secret-1234567890"
    });
    fs.writeFileSync(path.join(test.root, "shadow.sqlite"), Buffer.from("shadow"));
    const service = new BackupService(config, db, { fault: (point) => {
      if (point === "after-filesystem-replacement") throw new Error("injected failure");
    }});
    const artifact = await service.export();
    await expect(service.restore(artifact.path)).rejects.toMatchObject({ code: "backup_restore_failed" });
    expect(fs.readFileSync(path.join(test.storeRoot, "cartridges/unicode-ゲーム/1.0.0/qemu.prg32"))).toEqual(Buffer.from([0, 1, 2, 3, 4]));
    expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    service.cleanupArtifact(artifact);
    db.close();
  });

  it("detects and rolls back an incomplete operation after restart", async () => {
    const test = createDatabase();
    fs.writeFileSync(path.join(test.root, "shadow.sqlite"), Buffer.from("shadow"));
    const config = loadConfig({
      PRG32_BACKEND_DB: path.join(test.root, "shadow.sqlite"),
      PRG32_BACKEND_STORE_DATA: test.storeRoot,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: test.databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.join(test.root, "auth-workspace"),
      PRG32_BACKEND_BACKUP_ENABLED: "true",
      PRG32_BACKEND_BACKUP_MODE: "test",
      PRG32_BACKEND_SESSION_SECRET: "backup-session-secret-1234567890"
    });
    const db = new Database(test.databasePath);
    const service = new BackupService(config, db);
    const operationId = "rst-restart";
    const createRecoveryPoint = (service as unknown as { createRecoveryPoint: (id: string) => Promise<{ directory: string }> }).createRecoveryPoint.bind(service);
    const recovery = await createRecoveryPoint(operationId);
    fs.rmSync(path.join(test.storeRoot, "cartridges"), { recursive: true, force: true });
    const operationDirectory = path.join(test.storeRoot, "backup-operations", operationId);
    fs.mkdirSync(operationDirectory, { recursive: true });
    fs.writeFileSync(path.join(operationDirectory, "operation.json"), JSON.stringify({
      journalVersion: 1,
      operationId,
      state: "FILESYSTEM_REPLACED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      recoveryRelative: path.relative(test.storeRoot, recovery.directory).replaceAll(path.sep, "/")
    }));
    const restarted = new BackupService(config, db);
    restarted.recoverIncomplete();
    expect(fs.readFileSync(path.join(test.storeRoot, "cartridges/unicode-ゲーム/1.0.0/qemu.prg32"))).toEqual(Buffer.from([0, 1, 2, 3, 4]));
    expect(JSON.parse(fs.readFileSync(path.join(operationDirectory, "operation.json"), "utf8"))).toMatchObject({ state: "ROLLED_BACK" });
    db.close();
  });
});
