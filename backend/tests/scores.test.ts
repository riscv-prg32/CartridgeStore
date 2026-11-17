import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { ScoreRateLimiter } from "../src/scores/service.js";

const roots: string[] = [];
const BOOTSTRAP = "scores-bootstrap-token-1234567890";

const SCORE_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
  CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
  CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
  CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE scores (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, player TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL DEFAULT '');
  CREATE INDEX scores_game_score_idx ON scores(game, score DESC, created_at ASC);
  INSERT INTO groups(name) VALUES ('editors');
`;

function fixture(overrides: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m62b-scores-"));
  roots.push(root);
  const authRoot = path.join(root, "auth");
  const storeRoot = path.join(root, "store");
  fs.mkdirSync(authRoot); fs.mkdirSync(storeRoot);
  const databasePath = path.join(authRoot, "auth.sqlite");
  const shadowPath = path.join(root, "shadow.sqlite");
  const database = new Database(databasePath); database.exec(SCORE_SCHEMA); database.close();
  fs.writeFileSync(shadowPath, Buffer.from("shadow"));
  const app = buildApp({ config: loadConfig({
    PRG32_BACKEND_DB: shadowPath,
    PRG32_BACKEND_STORE_DATA: storeRoot,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: databasePath,
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: authRoot,
    PRG32_BACKEND_SCORES_WRITE_ENABLED: "true",
    PRG32_BACKEND_SCORES_WRITE_MODE: "test",
    PRG32_BACKEND_SCORES_DISPOSABLE_ROOT: authRoot,
    PRG32_BACKEND_SESSION_SECRET: "scores-session-secret-1234567890",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false",
    PRG32_BACKEND_SCORES_RATE_LIMIT_BURST: "32",
    ...overrides
  }), logger: false });
  return { app, root, databasePath };
}

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  return (Array.isArray(value) ? value[0] : value ?? "").split(";", 1)[0] ?? "";
}

async function adminSession(app: ReturnType<typeof buildApp>): Promise<{ cookie: string; csrf: string }> {
  const boot = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": BOOTSTRAP }, payload: { username: "scores-admin", email: "scores-admin@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
  const sessionCookie = cookie(boot);
  const csrf = await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie: sessionCookie } });
  const csrfBody = csrf.json<{ csrf_token: string }>();
  return { cookie: sessionCookie, csrf: csrfBody.csrf_token };
}

function score(game = "pong", player = "PLAYER", score = 1200): Record<string, unknown> {
  return { game, player, score };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("anonymous scores and leaderboard", () => {
  it("accepts firmware-shaped anonymous requests without credentials or CSRF", async () => {
    const test = fixture();
    const response = await test.app.inject({ method: "POST", url: "/api/scores", payload: score("breakout", "PLAYER", 4294967295) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const invalidHeader = await test.app.inject({ method: "POST", url: "/api/scores", headers: { authorization: "Bearer invalid-token" }, payload: score("breakout", "SECOND", 1) });
    expect(invalidHeader.statusCode).toBe(200);
    const db = new Database(test.databasePath, { readonly: true });
    expect(db.prepare("SELECT game, player, score, submitted_by FROM scores ORDER BY id").all()).toEqual([
      { game: "breakout", player: "PLAYER", score: 4294967295, submitted_by: "anonymous" },
      { game: "breakout", player: "SECOND", score: 1, submitted_by: "anonymous" }
    ]);
    db.close();
    await test.app.close();
  });

  it("keeps browser CSRF protection and accepts authenticated bearer requests", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const missingCsrf = await test.app.inject({ method: "POST", url: "/api/scores", headers: { cookie: admin.cookie }, payload: score() });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ code: "csrf_failed" });
    const browser = await test.app.inject({ method: "POST", url: "/api/scores", headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf }, payload: score("browser", "Admin", 2) });
    expect(browser.statusCode).toBe(200);
    const db = new Database(test.databasePath);
    const token = "prg32_scores-bearer-token";
    db.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(1, hashApiToken(token), "score test");
    db.close();
    const bearer = await test.app.inject({ method: "POST", url: "/api/scores", headers: { authorization: `Bearer ${token}` }, payload: score("bearer", "Admin", 3) });
    expect(bearer.statusCode).toBe(200);
    const verify = new Database(test.databasePath, { readonly: true });
    expect(verify.prepare("SELECT submitted_by FROM scores WHERE game = 'bearer'").get()).toEqual({ submitted_by: "scores-admin" });
    verify.close();
    await test.app.close();
  });

  it("preserves public filtering, limits, ordering, timestamps, and response fields", async () => {
    const test = fixture();
    const first = await test.app.inject({ method: "POST", url: "/api/scores", payload: score("pong", "Ada", 42) });
    expect(first.statusCode).toBe(200);
    const db = new Database(test.databasePath);
    db.prepare("INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)").run(
      "pong", "Grace", 99, 10, "anonymous", "pong", "Lin", 99, 20, "anonymous", "breakout", "Ada", 7, 30, "anonymous"
    );
    db.close();
    const all = await test.app.inject({ method: "GET", url: "/api/scores?game=pong&limit=2" });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual([
      { game: "pong", player: "Grace", score: 99, created_at: 10, submitted_by: "anonymous" },
      { game: "pong", player: "Lin", score: 99, created_at: 20, submitted_by: "anonymous" }
    ]);
    const player = await test.app.inject({ method: "GET", url: "/api/scores?player=Ada&limit=0" });
    const playerBody = player.json<Array<{ game: string; player: string; score: number; created_at: number; submitted_by: string }>>();
    expect(playerBody).toHaveLength(1);
    expect(playerBody[0]).toMatchObject({ game: "pong", player: "Ada", score: 42, submitted_by: "anonymous" });
    expect(typeof playerBody[0]?.created_at).toBe("number");
    await test.app.close();
  });

  it("rejects malformed, nested, oversized, fractional, negative, and out-of-range input", async () => {
    const test = fixture({ PRG32_BACKEND_SCORES_MAX_CONTENT_BYTES: "128" });
    const cases: Array<Record<string, unknown>> = [
      { game: "", player: "PLAYER", score: 1 },
      { game: "g", player: "", score: 1 },
      { game: "g".repeat(24), player: "PLAYER", score: 1 },
      { game: "g", player: "p".repeat(24), score: 1 },
      { game: "g", player: "p", score: -1 },
      { game: "g", player: "p", score: 1.5 },
      { game: "g", player: "p", score: 4294967296 },
      { game: "g", player: "p", score: { value: 1 } },
      ["g", "p", 1] as unknown as Record<string, unknown>
    ];
    for (const payload of cases) {
      const response = await test.app.inject({ method: "POST", url: "/api/scores", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_score_payload" });
    }
    const malformed = await test.app.inject({ method: "POST", url: "/api/scores", headers: { "content-type": "application/json" }, payload: "{bad" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "invalid_score_json" });
    const oversized = await test.app.inject({ method: "POST", url: "/api/scores", headers: { "content-type": "application/json" }, payload: JSON.stringify({ game: "g", player: "p", score: 1, extra: "x".repeat(300) }) });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ code: "score_payload_too_large" });
    const injection = await test.app.inject({ method: "POST", url: "/api/scores", payload: score("x' OR 1=1 --", "<script>", 9) });
    expect(injection.statusCode).toBe(200);
    const db = new Database(test.databasePath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM scores").get()).toEqual({ count: 1 });
    db.close();
    await test.app.close();
  });

  it("enforces rate limits, bounded limiter state, and recovery", async () => {
    const test = fixture({ PRG32_BACKEND_SCORES_RATE_LIMIT_MAX: "2", PRG32_BACKEND_SCORES_RATE_LIMIT_BURST: "2", PRG32_BACKEND_SCORES_RATE_LIMIT_MAX_CLIENTS: "2" });
    expect((await test.app.inject({ method: "POST", url: "/api/scores", headers: { "x-forwarded-for": "one" }, payload: score("rate", "one", 1) })).statusCode).toBe(200);
    expect((await test.app.inject({ method: "POST", url: "/api/scores", headers: { "x-forwarded-for": "two" }, payload: score("rate", "two", 2) })).statusCode).toBe(200);
    expect((await test.app.inject({ method: "POST", url: "/api/scores", headers: { "x-forwarded-for": "three" }, payload: score("rate", "three", 3) })).statusCode).toBe(429);
    expect((await test.app.inject({ method: "POST", url: "/api/scores", payload: score("rate", "four", 4) })).statusCode).toBe(429);
    await test.app.close();

    const limiter = new ScoreRateLimiter(2, 10, 2, 2);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 0)).toBe(false);
    expect(limiter.allow("b", 0)).toBe(true);
    expect(limiter.allow("c", 0)).toBe(true);
    expect(limiter.size()).toBe(2);
    expect(limiter.allow("c", 10_000)).toBe(true);
  });

  it("rejects at capacity without deletion and rolls back failed inserts", async () => {
    const test = fixture({ PRG32_BACKEND_SCORES_MAX_ROWS: "2" });
    expect((await test.app.inject({ method: "POST", url: "/api/scores", payload: score("capacity", "one", 1) })).statusCode).toBe(200);
    const db = new Database(test.databasePath);
    db.exec("DROP TRIGGER IF EXISTS score_fail_insert; CREATE TRIGGER score_fail_insert BEFORE INSERT ON scores BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    const failed = await test.app.inject({ method: "POST", url: "/api/scores", payload: score("failed", "rollback", 3) });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ ok: false, error: "score storage unavailable", code: "scores_storage_failed" });
    expect((db.prepare("SELECT COUNT(*) AS count FROM scores").get() as { count: number }).count).toBe(1);
    db.exec("DROP TRIGGER score_fail_insert");
    expect((await test.app.inject({ method: "POST", url: "/api/scores", payload: score("capacity", "two", 2) })).statusCode).toBe(200);
    const full = await test.app.inject({ method: "POST", url: "/api/scores", payload: score("capacity", "three", 4) });
    expect(full.statusCode).toBe(503);
    expect(full.headers["retry-after"]).toBe("60");
    expect(full.json()).toMatchObject({ code: "scores_capacity_reached" });
    expect((db.prepare("SELECT COUNT(*) AS count FROM scores").get() as { count: number }).count).toBe(2);
    db.close();
    await test.app.close();
  });

  it("serializes concurrent anonymous inserts without partial rows", async () => {
    const test = fixture({ PRG32_BACKEND_SCORES_RATE_LIMIT_BURST: "32" });
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => test.app.inject({
      method: "POST",
      url: "/api/scores",
      payload: score("concurrent", `P${index}`, index)
    })));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const db = new Database(test.databasePath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM scores WHERE game = 'concurrent'").get() as { count: number }).count).toBe(20);
    db.close();
    await test.app.close();
  });

  it("returns a stable error when SQLite is busy", async () => {
    const test = fixture({ PRG32_BACKEND_BUSY_TIMEOUT_MS: "25" });
    const locker = new Database(test.databasePath);
    locker.exec("BEGIN IMMEDIATE");
    const response = await test.app.inject({ method: "POST", url: "/api/scores", payload: score("locked", "retry", 1) });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "score storage unavailable", code: "scores_storage_failed" });
    locker.exec("ROLLBACK");
    locker.close();
    await test.app.close();
  });

  it("keeps public reads available while the score writer is disabled", async () => {
    const test = fixture({ PRG32_BACKEND_SCORES_WRITE_ENABLED: "false" });
    const db = new Database(test.databasePath);
    db.prepare("INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES (?, ?, ?, ?, ?)").run("readonly", "fixture", 10, 1, "fixture");
    db.close();
    expect((await test.app.inject({ method: "GET", url: "/api/scores" })).statusCode).toBe(200);
    const write = await test.app.inject({ method: "POST", url: "/api/scores", payload: score("readonly", "blocked", 11) });
    expect(write.statusCode).toBe(503);
    expect(write.json()).toMatchObject({ code: "scores_unavailable" });
    await test.app.close();
  });
});
