import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { ReviewService } from "../src/review/service.js";
import { parseCartridge } from "../src/submission/prg32.js";

const roots: string[] = [];
const BOOTSTRAP = "review-bootstrap-token-1234567890";
const PNG = Buffer.from("\x89PNG\r\n\x1a\n", "binary");

function legacy(): Buffer {
  const output = Buffer.alloc(84);
  output.write("PRG2", 0, "ascii");
  output.writeUInt16LE(1, 4);
  output.writeUInt16LE(72, 8);
  output.writeUInt32LE(12, 16);
  Buffer.from("\x13\x00\x00\x00\x13\x00\x00\x00\x13\x00\x00\x00", "binary").copy(output, 72);
  return output;
}

function bundle(): Uint8Array {
  return zipSync({
    "manifest.json": Buffer.from(JSON.stringify({
      abi: "prg32-metadata-1.0", id: "org.example.review", title: "Review Game", version: "1.0.0",
      authors: [{ name: "PRG32" }], tags: ["test"], assets: { icon: "icon.png" },
      architectures: [{ id: "qemu", file: "game-qemu.prg32" }, { id: "esp32c6", file: "game-esp32c6.prg32" }]
    })),
    "icon.png": PNG,
    "game-qemu.prg32": legacy(),
    "game-esp32c6.prg32": legacy()
  });
}

function databaseFixture(): { root: string; databasePath: string; storeRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52b-review-"));
  roots.push(root);
  const storeRoot = path.join(root, "store");
  fs.mkdirSync(storeRoot, { recursive: true });
  const authWorkspace = path.join(root, "auth-workspace");
  fs.mkdirSync(authWorkspace);
  const databasePath = path.join(authWorkspace, "auth.sqlite");
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE cartridge_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_by TEXT NOT NULL DEFAULT '', reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT NOT NULL DEFAULT '', pending_dir TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL, architectures_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT);
  `);
  database.close();
  return { root, databasePath, storeRoot };
}

function appFixture() {
  const fixture = databaseFixture();
  const shadow = path.join(fixture.root, "shadow.sqlite");
  fs.writeFileSync(shadow, Buffer.from("shadow"));
  const app = buildApp({ config: loadConfig({
    PRG32_BACKEND_DB: shadow,
    PRG32_BACKEND_STORE_DATA: fixture.storeRoot,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: fixture.databasePath,
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.join(fixture.root, "auth-workspace"),
    PRG32_BACKEND_SUBMISSION_WRITE_ENABLED: "true",
    PRG32_BACKEND_SUBMISSION_WRITE_MODE: "test",
    PRG32_BACKEND_SUBMISSION_DISPOSABLE_ROOT: fixture.storeRoot,
    PRG32_BACKEND_SESSION_SECRET: "review-session-secret-1234567890",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false"
  }), logger: false });
  return { app, ...fixture };
}

function header(response: { headers: Record<string, string | string[] | undefined> }, key: string): string {
  const value = response.headers[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function session(app: ReturnType<typeof buildApp>): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": BOOTSTRAP }, payload: { username: "editor", email: "editor@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
  const cookie = header(response, "set-cookie").split(";", 1)[0] ?? "";
  const csrf = (await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie } })).json<Record<string, unknown>>().csrf_token;
  return { cookie, csrf: csrf as string };
}

function multipart(bytes: Uint8Array, csrf: string): { body: Buffer; contentType: string } {
  const boundary = "----prg32-m52b-boundary";
  return {
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf_token"\r\n\r\n${csrf}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function submit(app: ReturnType<typeof buildApp>, auth: { cookie: string; csrf: string }): Promise<number> {
  const payload = multipart(bundle(), auth.csrf);
  const response = await app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "content-type": payload.contentType, "x-csrftoken": auth.csrf }, payload: payload.body });
  expect(response.statusCode).toBe(200);
  return response.json<Record<string, unknown>>().submission_id as number;
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("review and publication parity", () => {
  it("matches listing/detail contracts, enforces editors, and approves all variants with reviewed metadata", async () => {
    const fixture = appFixture();
    const auth = await session(fixture.app);
    const id = await submit(fixture.app, auth);
    expect((await fixture.app.inject({ method: "GET", url: "/api/submissions", headers: { cookie: auth.cookie } })).json<Record<string, unknown>>().submissions).toHaveLength(1);
    expect((await fixture.app.inject({ method: "GET", url: "/api/submissions/999", headers: { cookie: auth.cookie } })).json()).toEqual({ ok: false, error: "submission not found" });
    const verified = await fixture.app.inject({ method: "POST", url: `/api/submissions/${id}/verify`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf }, payload: { metadata: { title: "Reviewed Title", tags: ["approved"] } } });
    expect(verified.statusCode).toBe(200);
    const verifiedSubmission = verified.json<Record<string, unknown>>().submission as Record<string, unknown>;
    expect(verifiedSubmission).toMatchObject({ id, status: "verified", metadata: { title: "Reviewed Title", tags: ["approved"] }, reviewed_by: "editor" });
    const emailMessages = (await fixture.app.inject({ method: "GET", url: "/api/_test/email/messages", headers: { "x-prg32-bootstrap-token": BOOTSTRAP } })).json<Record<string, unknown>>().messages as Array<Record<string, unknown>>;
    expect(emailMessages.some((message) => message.to === "editor@example.test" && message.subject === "Reviewed Title 1.0.0 was approved")).toBe(true);
    for (const architecture of ["qemu", "esp32c6"]) {
      const file = fs.readFileSync(path.join(fixture.storeRoot, "cartridges/org.example.review/1.0.0", `${architecture}.prg32`));
      expect(parseCartridge(file).metadata?.title).toBe("Reviewed Title");
      const download = await fixture.app.inject({ method: "GET", url: `/api/games/org.example.review/download?version=1.0.0&architecture=${architecture}` });
      expect(download.statusCode).toBe(200);
      expect(parseCartridge(download.rawPayload).metadata?.title).toBe("Reviewed Title");
    }
    const adminDb = new Database(fixture.databasePath);
    adminDb.exec("DELETE FROM user_groups");
    adminDb.close();
    expect((await fixture.app.inject({ method: "GET", url: "/api/submissions", headers: { cookie: auth.cookie } })).statusCode).toBe(403);
    await fixture.app.close();
  });

  it("rejects safely, is idempotent under concurrency, and preserves CSRF boundaries", async () => {
    const fixture = appFixture();
    const auth = await session(fixture.app);
    const first = await submit(fixture.app, auth);
    const rejected = await fixture.app.inject({ method: "POST", url: `/api/submissions/${first}/reject`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf } });
    expect(rejected.statusCode).toBe(200);
    const rejectedSubmission = rejected.json<Record<string, unknown>>().submission as Record<string, unknown>;
    expect(rejectedSubmission.status).toBe("rejected");
    expect(fs.existsSync(path.join(fixture.storeRoot, `pending/${first}`))).toBe(false);
    expect((await fixture.app.inject({ method: "POST", url: `/api/submissions/${first}/reject`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf } })).statusCode).toBe(400);
    const second = await submit(fixture.app, auth);
    const responses = await Promise.all([
      fixture.app.inject({ method: "POST", url: `/api/submissions/${second}/reject`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf } }),
      fixture.app.inject({ method: "POST", url: `/api/submissions/${second}/reject`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf } })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
    expect((await fixture.app.inject({ method: "POST", url: `/api/submissions/${first}/reject`, headers: { cookie: auth.cookie } })).statusCode).toBe(403);
    await fixture.app.close();
  });

  it("recovers an actual process interruption during approval and rejection", async () => {
    const fixture = appFixture();
    const auth = await session(fixture.app);
    const approvalId = await submit(fixture.app, auth);
    const rejectionId = await submit(fixture.app, auth);
    await fixture.app.close();
    const databasePath = fixture.databasePath;
    const approvalChild = spawnSync(process.execPath, ["--import", "tsx", path.resolve("tests/fixtures/kill-review.ts")], { cwd: process.cwd(), env: { ...process.env, PRG32_TEST_ROOT: fixture.storeRoot, PRG32_TEST_DATABASE: databasePath, PRG32_TEST_SUBMISSION: String(approvalId), PRG32_TEST_MODE: "approve" }, encoding: "utf8" });
    expect(approvalChild.signal).toBe("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const database = new Database(databasePath);
    const review = new ReviewService({ root: fixture.storeRoot, database });
    const publicationOperations = review.publication.listOperations();
    expect(publicationOperations).toHaveLength(1);
    expect(review.publication.reconcile().status).toBe("RECOVERABLE");
    expect(review.publication.recover(publicationOperations[0]!.operationId, "resume").state).toBe("COMPLETED");
    expect(review.detail(approvalId)).toMatchObject({ status: "verified", metadata: { title: "Crash Approved" } });
    database.close();

    const rejectionChild = spawnSync(process.execPath, ["--import", "tsx", path.resolve("tests/fixtures/kill-review.ts")], { cwd: process.cwd(), env: { ...process.env, PRG32_TEST_ROOT: fixture.storeRoot, PRG32_TEST_DATABASE: databasePath, PRG32_TEST_SUBMISSION: String(rejectionId), PRG32_TEST_MODE: "reject" }, encoding: "utf8" });
    expect(rejectionChild.signal).toBe("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const recoveryDatabase = new Database(databasePath);
    const recovery = new ReviewService({ root: fixture.storeRoot, database: recoveryDatabase });
    expect(recovery.reconcile()).toEqual(expect.arrayContaining([expect.objectContaining({ code: "INCOMPLETE_REJECTION_CLEANUP" })]));
    const rejectionOperations = fs.readdirSync(path.join(fixture.storeRoot, "review-operations"));
    const rejectionOperation = rejectionOperations.find((value) => value.startsWith("rej-"));
    expect(rejectionOperation).toBeDefined();
    recovery.recoverRejection(rejectionOperation as string);
    expect(recovery.detail(rejectionId).status).toBe("rejected");
    expect(fs.existsSync(path.join(fixture.storeRoot, `pending/${rejectionId}`))).toBe(false);
    expect(recovery.reconcile()).toEqual([]);
    recoveryDatabase.close();
  }, 20000);

  it("keeps a copied disposable store recoverable for backup and restore", async () => {
    const fixture = appFixture();
    const auth = await session(fixture.app);
    const id = await submit(fixture.app, auth);
    await fixture.app.close();
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52b-restore-"));
    roots.push(backup);
    fs.cpSync(fixture.storeRoot, path.join(backup, "store"), { recursive: true });
    fs.copyFileSync(fixture.databasePath, path.join(backup, "auth.sqlite"));
    const database = new Database(path.join(backup, "auth.sqlite"));
    const review = new ReviewService({ root: path.join(backup, "store"), database });
    expect(review.reconcile()).toEqual([]);
    expect(review.detail(id).status).toBe("pending");
    database.close();
  });
});
