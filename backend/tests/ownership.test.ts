import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";

const roots: string[] = [];
const PNG = Buffer.from("\x89PNG\r\n\x1a\n", "binary");
const PASSWORD_HASH = "scrypt:32768:8:1$Sg8aDcBd0VcXm3ND$d032cc543048ff7d120b153c5af84f22d2c4592f80e9636b60069ccc532fc8d7b1147bf7340295488f2a7d0a9d61c6161ee73bef31632414a4ede2c18a100c7d";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m21-ownership-"));
  roots.push(root);
  const authRoot = path.join(root, "auth");
  const storeRoot = path.join(root, "store");
  fs.mkdirSync(authRoot);
  fs.mkdirSync(storeRoot);
  const databasePath = path.join(authRoot, "auth.sqlite");
  const shadowPath = path.join(root, "shadow.sqlite");
  fs.writeFileSync(shadowPath, Buffer.from("shadow"));
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE cartridge_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_by TEXT NOT NULL DEFAULT '', reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT NOT NULL DEFAULT '', pending_dir TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL, architectures_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT);
    INSERT INTO groups(name) VALUES ('editors');
  `);
  database.prepare("INSERT INTO users(username, email, password_hash, role) VALUES (?, ?, ?, 'user')").run("developer-a", "a@example.test", PASSWORD_HASH);
  database.prepare("INSERT INTO users(username, email, password_hash, role) VALUES (?, ?, ?, 'user')").run("developer-b", "b@example.test", PASSWORD_HASH);
  database.prepare("INSERT INTO users(username, email, password_hash, role) VALUES (?, ?, ?, 'user')").run("reviewer", "reviewer@example.test", PASSWORD_HASH);
  database.prepare("INSERT INTO user_groups(user_id, group_id) VALUES (3, 1)").run();
  for (const [userId, token] of [[1, "prg32-owner-a"], [2, "prg32-owner-b"], [3, "prg32-reviewer"]] as const) {
    database.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(userId, hashApiToken(token), token);
  }
  database.close();
  const app = buildApp({
    config: loadConfig({
      PRG32_BACKEND_DB: shadowPath,
      PRG32_BACKEND_STORE_DATA: storeRoot,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: authRoot,
      PRG32_BACKEND_SUBMISSION_WRITE_ENABLED: "true",
      PRG32_BACKEND_SUBMISSION_WRITE_MODE: "test",
      PRG32_BACKEND_SUBMISSION_DISPOSABLE_ROOT: storeRoot,
      PRG32_BACKEND_SESSION_SECRET: "ownership-test-session-secret-1234567890",
      PRG32_BACKEND_SESSION_SECURE: "false"
    }),
    logger: false
  });
  return { app, databasePath, storeRoot, tokens: { a: "prg32-owner-a", b: "prg32-owner-b", reviewer: "prg32-reviewer" } };
}

function bundle(gameId = "org.example.ownership"): Uint8Array {
  const cartridge = Buffer.alloc(84);
  cartridge.write("PRG2", 0, "ascii");
  cartridge.writeUInt16LE(1, 4);
  cartridge.writeUInt16LE(72, 8);
  cartridge.writeUInt32LE(12, 16);
  Buffer.from("\x13\x00\x00\x00\x13\x00\x00\x00\x13\x00\x00\x00", "binary").copy(cartridge, 72);
  return zipSync({
    "manifest.json": Buffer.from(JSON.stringify({ abi: "prg32-metadata-1.0", id: gameId, title: "Ownership Game", version: "1.0.0", authors: [{ name: "PRG32" }], tags: ["test"], assets: { icon: "icon.png" }, architectures: [{ id: "qemu", file: "game.prg32" }] })),
    "icon.png": PNG,
    "game.prg32": cartridge
  });
}

function multipart(bytes: Uint8Array): { body: Buffer; contentType: string } {
  const boundary = "----prg32-m21-ownership";
  return { body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.zip"\r\nContent-Type: application/zip\r\n\r\n`), Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function submit(app: ReturnType<typeof buildApp>, token: string, gameId: string) {
  const payload = multipart(bundle(gameId));
  return app.inject({ method: "POST", url: "/api/publish/bundle", headers: { authorization: `Bearer ${token}`, "content-type": payload.contentType }, payload: payload.body });
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("developer-owned submission API", () => {
  it("denies anonymous and invalid sessions without scanning private data", async () => {
    const test = fixture();
    expect((await test.app.inject({ method: "GET", url: "/api/submissions/mine" })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "GET", url: "/api/submissions/mine", headers: { cookie: "prg32_ts_session=invalid" } })).statusCode).toBe(401);
    await test.app.close();
  });

  it("lists only the authenticated owner and ignores caller ownership overrides", async () => {
    const test = fixture();
    expect((await submit(test.app, test.tokens.a, "org.example.a")).statusCode).toBe(200);
    expect((await submit(test.app, test.tokens.b, "org.example.b")).statusCode).toBe(200);
    const mineA = await test.app.inject({ method: "GET", url: "/api/submissions/mine?user_id=2", headers: { authorization: `Bearer ${test.tokens.a}` } });
    expect(mineA.statusCode).toBe(200);
    expect(mineA.json()).toMatchObject({ ok: true, pagination: { total: 1 }, submissions: [{ game_id: "org.example.a", title: "Ownership Game", status: "pending" }] });
    const mineB = await test.app.inject({ method: "GET", url: "/api/submissions/mine", headers: { authorization: `Bearer ${test.tokens.b}` } });
    expect(mineB.json()).toMatchObject({ ok: true, pagination: { total: 1 }, submissions: [{ game_id: "org.example.b" }] });
    await test.app.close();
  });

  it("supports bounded pagination, stable ordering, and status filters", async () => {
    const test = fixture();
    await submit(test.app, test.tokens.a, "org.example.first");
    await submit(test.app, test.tokens.a, "org.example.second");
    const page = await test.app.inject({ method: "GET", url: "/api/submissions/mine?page=1&per_page=1", headers: { authorization: `Bearer ${test.tokens.a}` } });
    expect(page.json()).toMatchObject({ pagination: { page: 1, per_page: 1, total: 2, pages: 2, has_next: true }, submissions: [{ game_id: "org.example.second" }] });
    expect((await test.app.inject({ method: "GET", url: "/api/submissions/mine?per_page=101", headers: { authorization: `Bearer ${test.tokens.a}` } })).json()).toEqual({ ok: false, error: "invalid request", code: "invalid_request" });
    expect((await test.app.inject({ method: "GET", url: "/api/submissions/mine?status=unknown", headers: { authorization: `Bearer ${test.tokens.a}` } })).json()).toEqual({ ok: false, error: "invalid request", code: "invalid_request" });
    await test.app.close();
  });

  it("keeps the editor queue separate from the owner endpoint", async () => {
    const test = fixture();
    await submit(test.app, test.tokens.a, "org.example.review");
    expect((await test.app.inject({ method: "GET", url: "/api/submissions", headers: { authorization: `Bearer ${test.tokens.a}` } })).statusCode).toBe(403);
    expect((await test.app.inject({ method: "GET", url: "/api/submissions", headers: { authorization: `Bearer ${test.tokens.reviewer}` } })).statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: "/api/submissions/mine", headers: { authorization: `Bearer ${test.tokens.reviewer}` } })).json()).toMatchObject({ ok: true, pagination: { total: 0 }, submissions: [] });
    await test.app.close();
  });
});
