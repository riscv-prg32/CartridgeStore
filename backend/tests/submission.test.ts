import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { SubmissionService } from "../src/submission/service.js";

const temporaryDirectories: string[] = [];
const BOOTSTRAP = "submission-bootstrap-token-1234567890";
const PNG = Buffer.from("\x89PNG\r\n\x1a\n", "binary");

function createDatabase(withSubmissionTable = true): { databasePath: string; storeRoot: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m51-submission-"));
  temporaryDirectories.push(directory);
  const disposableRoot = path.join(directory, "auth");
  const storeRoot = path.join(directory, "store");
  fs.mkdirSync(disposableRoot);
  fs.mkdirSync(storeRoot);
  const databasePath = path.join(disposableRoot, "auth.sqlite");
  const sqlite = new Database(databasePath);
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${withSubmissionTable ? "CREATE TABLE cartridge_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_by TEXT NOT NULL DEFAULT '', reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT NOT NULL DEFAULT '', pending_dir TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL, architectures_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT);" : ""}
  `);
  sqlite.close();
  return { databasePath, storeRoot };
}

function createAppFixture(options: { withSubmissionTable?: boolean; overrides?: Record<string, string> } = {}) {
  const fixture = createDatabase(options.withSubmissionTable ?? true);
  const shadow = path.join(path.dirname(path.dirname(fixture.databasePath)), "shadow.sqlite");
  fs.writeFileSync(shadow, Buffer.from("shadow"));
  const app = buildApp({
    config: loadConfig({
      PRG32_BACKEND_DB: shadow,
      PRG32_BACKEND_STORE_DATA: fixture.storeRoot,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: fixture.databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.dirname(fixture.databasePath),
      PRG32_BACKEND_SUBMISSION_WRITE_ENABLED: "true",
      PRG32_BACKEND_SUBMISSION_WRITE_MODE: "test",
      PRG32_BACKEND_SUBMISSION_DISPOSABLE_ROOT: fixture.storeRoot,
      PRG32_BACKEND_SESSION_SECRET: "submission-session-secret-1234567890",
      PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
      PRG32_BACKEND_SESSION_SECURE: "false",
      ...options.overrides
    }),
    logger: false
  });
  return { app, ...fixture };
}

function fakeCartridge(): Buffer {
  const output = Buffer.alloc(72 + 12);
  output.write("PRG2", 0, "ascii");
  output.writeUInt16LE(1, 4);
  output.writeUInt16LE(72, 8);
  output.writeUInt32LE(12, 16);
  Buffer.from("\x13\x00\x00\x00\x13\x00\x00\x00\x13\x00\x00\x00", "binary").copy(output, 72);
  return output;
}

function bundle(overrides: Record<string, unknown> = {}, files: Record<string, Uint8Array> = {}): Uint8Array {
  const manifest = {
    abi: "prg32-metadata-1.0",
    id: "org.example.test",
    title: "Submission Game",
    version: "1.0.0",
    authors: [{ name: "PRG32" }],
    tags: ["test"],
    assets: { icon: "icon.png" },
    architectures: [{ id: "qemu", file: "game-qemu.prg32" }],
    ...overrides
  };
  return zipSync({
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "icon.png": PNG,
    "game-qemu.prg32": fakeCartridge(),
    ...files
  });
}

function multipart(bundleBytes: Uint8Array, csrfToken = "", fileName = "bundle.zip"): { body: Buffer; contentType: string } {
  const boundary = "----prg32-m51-boundary";
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf_token"\r\n\r\n${csrfToken}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`),
    Buffer.from(bundleBytes),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function header(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function session(app: ReturnType<typeof buildApp>): Promise<{ cookie: string; csrf: string }> {
  const boot = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": BOOTSTRAP }, payload: { username: "submitter", email: "submitter@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
  const cookie = header(boot, "set-cookie").split(";", 1)[0] ?? "";
  const csrfResponse = await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie } });
  const body = csrfResponse.json<Record<string, unknown>>();
  return { cookie, csrf: body.csrf_token as string };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("publishing foundation", () => {
  it("creates a pending submission owned by the authenticated principal", async () => {
    const fixture = createAppFixture();
    const auth = await session(fixture.app);
    const payload = multipart(bundle(), auth.csrf);
    const response = await fixture.app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "content-type": payload.contentType, "x-csrftoken": auth.csrf }, payload: payload.body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, status: "pending", review_required: true, id: "org.example.test", version: "1.0.0", submitted: [{ architecture: "qemu", file: "game-qemu.prg32" }] });
    const sqlite = new Database(fixture.databasePath, { readonly: true });
    const row = sqlite.prepare("SELECT submitted_by_user_id, submitted_by, status, pending_dir FROM cartridge_submissions").get() as Record<string, unknown>;
    expect(row).toMatchObject({ submitted_by_user_id: 1, submitted_by: "submitter", status: "pending", pending_dir: "pending/1" });
    sqlite.close();
    expect(fs.readFileSync(path.join(fixture.storeRoot, "pending/1/qemu.prg32")).subarray(0, 4).toString("ascii")).toBe("PRG2");
    expect(fs.existsSync(path.join(fixture.storeRoot, "index.json"))).toBe(false);
    await fixture.app.close();
  });

  it("preserves the legacy API alias and rejects missing or invalid authentication", async () => {
    const fixture = createAppFixture();
    const payload = multipart(bundle());
    expect((await fixture.app.inject({ method: "POST", url: "/api/publish/bundle", headers: { "content-type": payload.contentType }, payload: payload.body })).statusCode).toBe(401);
    const auth = await session(fixture.app);
    const invalidCsrf = multipart(bundle(), "wrong-csrf");
    expect((await fixture.app.inject({ method: "POST", url: "/api/publish", headers: { cookie: auth.cookie, "content-type": invalidCsrf.contentType }, payload: invalidCsrf.body })).statusCode).toBe(403);
    const valid = multipart(bundle(), auth.csrf);
    const response = await fixture.app.inject({ method: "POST", url: "/api/publish", headers: { cookie: auth.cookie, "content-type": valid.contentType }, payload: valid.body });
    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>().legacy_endpoint).toBe(true);
    await fixture.app.close();
  });

  it("rejects unsafe, malformed, invalid-binary, and resource-exhausting bundles", async () => {
    const fixture = createAppFixture({ overrides: { PRG32_BACKEND_SUBMISSION_MAX_ENTRY_BYTES: "64", PRG32_BACKEND_SUBMISSION_MAX_TOTAL_BYTES: "100" } });
    const auth = await session(fixture.app);
    const submit = async (bytes: Uint8Array) => {
      const payload = multipart(bytes, auth.csrf);
      return fixture.app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "content-type": payload.contentType }, payload: payload.body });
    };
    const invalidZip = await submit(Buffer.from("not-a-zip"));
    expect(invalidZip.statusCode).toBe(400);
    expect(invalidZip.json()).toEqual({ ok: false, error: "invalid request", code: "invalid_request" });
    expect((await submit(bundle({ assets: { icon: "../icon.png" } }))).statusCode).toBe(400);
    expect((await submit(bundle({}, { "large.bin": Buffer.alloc(65, 1) }))).statusCode).toBe(400);
    await fixture.app.close();

    const invalidFixture = createAppFixture();
    const invalidAuth = await session(invalidFixture.app);
    const invalidManifest = { architectures: [{ id: "qemu", file: "bad.prg32" }] };
    const invalidPayload = multipart(bundle(invalidManifest, { "bad.prg32": Buffer.from("bad") }), invalidAuth.csrf);
    const invalidResponse = await invalidFixture.app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: invalidAuth.cookie, "content-type": invalidPayload.contentType }, payload: invalidPayload.body });
    expect(invalidResponse.statusCode).toBe(400);
    await invalidFixture.app.close();
  });

  it("compensates the database row when the submission schema is unavailable", async () => {
    const fixture = createAppFixture({ withSubmissionTable: false });
    const auth = await session(fixture.app);
    const payload = multipart(bundle(), auth.csrf);
    const response = await fixture.app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "content-type": payload.contentType }, payload: payload.body });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "submission could not be stored", code: "submission_storage_failed" });
    expect(fs.existsSync(path.join(fixture.storeRoot, "pending"))).toBe(true);
    await fixture.app.close();
  });

  it("compensates a database insert when pending binary storage fails", async () => {
    const fixture = createAppFixture();
    const config = loadConfig({
      PRG32_BACKEND_DB: path.join(path.dirname(path.dirname(fixture.databasePath)), "shadow-storage.sqlite"),
      PRG32_BACKEND_STORE_DATA: fixture.storeRoot,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: fixture.databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.dirname(fixture.databasePath),
      PRG32_BACKEND_SUBMISSION_WRITE_ENABLED: "true",
      PRG32_BACKEND_SUBMISSION_WRITE_MODE: "test",
      PRG32_BACKEND_SUBMISSION_DISPOSABLE_ROOT: fixture.storeRoot,
      PRG32_BACKEND_SESSION_SECRET: "submission-session-secret-1234567890"
    });
    fs.writeFileSync(config.databasePath, Buffer.from("shadow"));
    const sqlite = new Database(fixture.databasePath);
    sqlite.prepare("INSERT INTO users(username, email, role) VALUES (?, ?, ?)").run("owner", "owner@example.test", "user");
    let removed = 0;
    let staged = 0;
    const service = new SubmissionService({
      config,
      database: sqlite,
      storage: {
        stage: () => { staged += 1; throw new Error("synthetic binary write failure"); },
        remove: () => { removed += 1; }
      }
    });
    let caught: unknown;
    try {
      service.createFromBundle(bundle(), { authenticated: true, id: 1, name: "owner", username: "owner", email: "owner@example.test", role: "user", groups: [], authMethod: "session" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ message: "submission could not be stored" });
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM cartridge_submissions").get() as { count: number }).count).toBe(0);
    expect(staged).toBe(1);
    expect(removed).toBe(1);
    sqlite.close();
    await fixture.app.close();
  });

  it("allocates deterministic isolated pending directories for concurrent submissions", async () => {
    const fixture = createAppFixture();
    const auth = await session(fixture.app);
    const makeRequest = async () => {
      const payload = multipart(bundle(), auth.csrf);
      return fixture.app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "content-type": payload.contentType }, payload: payload.body });
    };
    const responses = await Promise.all([makeRequest(), makeRequest()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 200]);
    expect(fs.existsSync(path.join(fixture.storeRoot, "pending/1/qemu.prg32"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.storeRoot, "pending/2/qemu.prg32"))).toBe(true);
    await fixture.app.close();
  });
});
