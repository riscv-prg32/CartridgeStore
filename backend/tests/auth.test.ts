import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { authorizedForGroup, authorizedForRole, type Principal } from "../src/auth/principal.js";
import { verifyWerkzeugPasswordHash } from "../src/auth/password.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { SessionStore } from "../src/auth/session.js";

const temporaryDirectories: string[] = [];
const TEST_BOOTSTRAP_TOKEN = "bootstrap-test-secret-1234567890";

function createAuthDatabase(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m41-auth-"));
  temporaryDirectories.push(directory);
  const disposableRoot = path.join(directory, "disposable");
  fs.mkdirSync(disposableRoot);
  const databasePath = path.join(disposableRoot, "auth.sqlite");
  const sqlite = new Database(databasePath);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO groups(name) VALUES ('editors');
  `);
  sqlite.close();
  return databasePath;
}

function createApp(databasePath: string, overrides: Record<string, string> = {}) {
  const shadowDatabasePath = path.join(path.dirname(path.dirname(databasePath)), "operational-shadow.sqlite");
  fs.closeSync(fs.openSync(shadowDatabasePath, "a"));
  return buildApp({
    config: loadConfig({
      PRG32_BACKEND_DB: shadowDatabasePath,
      PRG32_BACKEND_STORE_DATA: path.dirname(databasePath),
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.dirname(databasePath),
      PRG32_BACKEND_SESSION_SECRET: "test-only-session-secret-that-is-long-enough",
      PRG32_BACKEND_BOOTSTRAP_TOKEN: TEST_BOOTSTRAP_TOKEN,
      PRG32_BACKEND_SESSION_SECURE: "false",
      ...overrides
    }),
    logger: false
  });
}

function header(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function jsonBody(response: { json(): unknown }): Record<string, unknown> {
  const value = response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
  return value as Record<string, unknown>;
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

async function csrf(app: ReturnType<typeof buildApp>, cookie = "") {
  const response = await app.inject({ method: "GET", url: "/auth/csrf", headers: cookie ? { cookie } : {} });
  return { token: jsonBody(response).csrf_token as string, cookie: cookie || cookieFrom(response) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("isolated authentication foundation", () => {
  it("completes username registration and password recovery through the in-memory mail transport", async () => {
    const databasePath = createAuthDatabase();
    const app = createApp(databasePath);
    const initial = await csrf(app);
    const requested = await app.inject({ method: "POST", url: "/auth/register", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { username: "new-user", email: "new-user@example.test", password: "registration-password", password_confirm: "registration-password" } });
    expect(requested.statusCode).toBe(200);
    const mail = await app.inject({ method: "GET", url: "/api/_test/email/messages", headers: { "x-prg32-bootstrap-token": TEST_BOOTSTRAP_TOKEN } });
    const registrationText = (mail.json<{ messages: Array<{ text: string }> }>().messages.at(-1)?.text ?? "");
    const registrationToken = new URL(registrationText.match(/https?:\/\/\S+/u)?.[0] ?? "http://invalid").searchParams.get("token") ?? "";
    const completed = await app.inject({ method: "POST", url: "/auth/register/complete", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { token: registrationToken } });
    expect(completed.statusCode).toBe(200);
    expect((completed.json<{ user: { username: string } }>().user).username).toBe("new-user");
    const activeCookie = cookieFrom(completed);
    const activeCsrf = await csrf(app, activeCookie);
    const resetRequest = await app.inject({ method: "POST", url: "/auth/password/reset/request", headers: { cookie: activeCookie, "x-csrftoken": activeCsrf.token }, payload: { identifier: "new-user" } });
    expect(resetRequest.statusCode).toBe(200);
    const resetMail = await app.inject({ method: "GET", url: "/api/_test/email/messages", headers: { "x-prg32-bootstrap-token": TEST_BOOTSTRAP_TOKEN } });
    const resetText = (resetMail.json<{ messages: Array<{ text: string }> }>().messages.at(-1)?.text ?? "");
    const resetToken = new URL(resetText.match(/https?:\/\/\S+/u)?.[0] ?? "http://invalid").searchParams.get("token") ?? "";
    const resetCsrf = await csrf(app);
    const reset = await app.inject({ method: "POST", url: "/auth/password/reset/complete", headers: { cookie: resetCsrf.cookie, "x-csrftoken": resetCsrf.token }, payload: { token: resetToken, password: "reset-password-123", password_confirm: "reset-password-123" } });
    expect(reset.statusCode).toBe(200);
    const replay = await app.inject({ method: "POST", url: "/auth/password/reset/complete", headers: { cookie: resetCsrf.cookie, "x-csrftoken": resetCsrf.token }, payload: { token: resetToken, password: "reset-password-123", password_confirm: "reset-password-123" } });
    expect(replay.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: initial.cookie } })).statusCode).toBe(401);
    await app.close();
  });
  it("fails closed when write isolation is missing or points at the shadow database", () => {
    expect(() => loadConfig({ PRG32_BACKEND_AUTH_WRITE_ENABLED: "true" })).toThrow("AUTH_WRITE_MODE");
    expect(() => loadConfig({
      PRG32_BACKEND_DB: "/tmp/store.sqlite",
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: "/tmp/store.sqlite",
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: "/tmp",
      PRG32_BACKEND_SESSION_SECRET: "test-session-secret-1234567890-abcdef"
    })).toThrow("separate");
  });

  it("supports one-time bootstrap atomically and prevents concurrent reuse", async () => {
    const databasePath = createAuthDatabase();
    const app = createApp(databasePath);
    const invalid = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": "x".repeat(TEST_BOOTSTRAP_TOKEN.length) }, payload: { username: "wrong", email: "wrong@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
    expect(invalid.statusCode).toBe(403);
    const requests = await Promise.all([
      app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": TEST_BOOTSTRAP_TOKEN }, payload: { username: "admin-one", email: "admin-one@example.test", password: "long-password-123", password_confirm: "long-password-123" } }),
      app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": TEST_BOOTSTRAP_TOKEN }, payload: { username: "admin-two", email: "admin-two@example.test", password: "long-password-123", password_confirm: "long-password-123" } })
    ]);
    expect(requests.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const sqlite = new Database(databasePath, { readonly: true });
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as { count: number }).count).toBe(1);
    expect((sqlite.prepare("SELECT value FROM store_settings WHERE key = 'auth_bootstrap_completed'").get() as { value: string }).value).toBe("true");
    sqlite.close();
    await app.close();
  });

  it("issues a distinct rotated session, enforces CSRF, and invalidates logout", async () => {
    const app = createApp(createAuthDatabase());
    const initial = await csrf(app);
    const loginWithoutCsrf = await app.inject({ method: "POST", url: "/auth/login", headers: { cookie: initial.cookie }, payload: { username: "missing", password: "missing" } });
    expect(loginWithoutCsrf.statusCode).toBe(403);
    const loginWithWrongCsrf = await app.inject({ method: "POST", url: "/auth/login", headers: { cookie: initial.cookie, "x-csrftoken": "x".repeat(initial.token.length) }, payload: { username: "missing", password: "missing" } });
    expect(loginWithWrongCsrf.statusCode).toBe(403);
    const boot = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": TEST_BOOTSTRAP_TOKEN }, payload: { username: "admin", email: "admin@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
    const bootCookie = cookieFrom(boot);
    const bootCsrf = await csrf(app, bootCookie);
    const login = await app.inject({ method: "POST", url: "/auth/login", headers: { cookie: bootCookie, "x-csrftoken": bootCsrf.token }, payload: { username: "admin", password: "wrong-password" } });
    expect(login.statusCode).toBe(401);
    const validLogin = await app.inject({ method: "POST", url: "/auth/login", headers: { cookie: bootCookie, "x-csrftoken": bootCsrf.token }, payload: { username: "admin", password: "long-password-123" } });
    expect(validLogin.json<{ user: { permissions: string[] } }>().user.permissions).toEqual(expect.arrayContaining(["settings:read", "users:read", "catalog:metadata:write"]));
    const rotatedCookie = cookieFrom(validLogin);
    expect(header(validLogin, "set-cookie")).toMatch(/HttpOnly/);
    expect(header(validLogin, "set-cookie")).toMatch(/SameSite=Lax/);
    expect(header(validLogin, "set-cookie")).toMatch(/Path=\//);
    expect(rotatedCookie).not.toBe(bootCookie);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: bootCookie } })).statusCode).toBe(401);
    const dualOriginMe = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: rotatedCookie } });
    expect(dualOriginMe.statusCode).toBe(200);
    expect(jsonBody(dualOriginMe).user).toMatchObject({ username: "admin", email: "admin@example.test" });
    const currentCsrf = await csrf(app, rotatedCookie);
    const profile = await app.inject({
      method: "PATCH",
      url: "/auth/profile",
      headers: { cookie: rotatedCookie, "x-csrftoken": currentCsrf.token },
      payload: { display_name: "Ada Lovelace" },
    });
    expect(profile.statusCode).toBe(200);
    expect(jsonBody(profile).user).toMatchObject({
      name: "Ada Lovelace",
      username: "admin",
    });
    const updatedMe = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: rotatedCookie },
    });
    expect(jsonBody(updatedMe).user).toMatchObject({ name: "Ada Lovelace" });
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: rotatedCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: rotatedCookie, "x-csrftoken": currentCsrf.token } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: rotatedCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: "prg32_ts_session=%E0%A4%A" } })).statusCode).toBe(401);
    await app.close();
  });

  it("accepts bearer tokens without browser CSRF and supports token lifecycle", async () => {
    const databasePath = createAuthDatabase();
    const sqlite = new Database(databasePath);
    const passwordHash = "scrypt:32768:8:1$Sg8aDcBd0VcXm3ND$d032cc543048ff7d120b153c5af84f22d2c4592f80e9636b60069ccc532fc8d7b1147bf7340295488f2a7d0a9d61c6161ee73bef31632414a4ede2c18a100c7d";
    sqlite.prepare("INSERT INTO users(username, email, password_hash, role) VALUES (?, ?, ?, ?)").run("publisher", "publisher@example.test", passwordHash, "publisher");
    sqlite.prepare("INSERT INTO user_groups(user_id, group_id) VALUES (1, 1)").run();
    const token = "prg32_existing-token";
    sqlite.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (1, ?, ?)").run(hashApiToken(token), "fixture token");
    sqlite.close();
    const app = createApp(databasePath);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(jsonBody(me).user).toMatchObject({ id: 1, role: "publisher", groups: ["editors"] });
    const created = await app.inject({ method: "POST", url: "/auth/tokens", headers: { authorization: `Bearer ${token}` }, payload: { label: "new token" } });
    expect(created.statusCode).toBe(200);
    expect(jsonBody(created).token).toMatch(/^prg32_/);
    const tokenId = jsonBody(created).id as number;
    const revoked = await app.inject({ method: "DELETE", url: `/auth/tokens/${tokenId}`, headers: { authorization: `Bearer ${token}` } });
    expect(revoked.statusCode).toBe(200);
    await app.close();
  });

  it("keeps token list, rename, and revoke operations scoped to the bearer owner", async () => {
    const databasePath = createAuthDatabase();
    const sqlite = new Database(databasePath);
    const passwordHash = "scrypt:32768:8:1$Sg8aDcBd0VcXm3ND$d032cc543048ff7d120b153c5af84f22d2c4592f80e9636b60069ccc532fc8d7b1147bf7340295488f2a7d0a9d61c6161ee73bef31632414a4ede2c18a100c7d";
    sqlite.prepare("INSERT INTO users(username, email, password_hash, role) VALUES (?, ?, ?, ?)").run("owner", "owner@example.test", passwordHash, "user");
    sqlite.prepare("INSERT INTO users(username, email, password_hash, role) VALUES (?, ?, ?, ?)").run("other", "other@example.test", passwordHash, "user");
    const ownerToken = "prg32_owner-token";
    const otherToken = "prg32_other-token";
    sqlite.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (1, ?, ?)").run(hashApiToken(ownerToken), "owner token");
    const otherTokenId = Number(sqlite.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (2, ?, ?)").run(hashApiToken(otherToken), "other token").lastInsertRowid);
    sqlite.close();

    const app = createApp(databasePath);
    const list = await app.inject({ method: "GET", url: "/auth/tokens", headers: { authorization: `Bearer ${ownerToken}` } });
    expect((jsonBody(list).tokens as Array<Record<string, unknown>>).map((token) => token.id)).not.toContain(otherTokenId);
    const renamed = await app.inject({ method: "PATCH", url: `/auth/tokens/${otherTokenId}`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { label: "attacked" } });
    expect(jsonBody(renamed)).toEqual({ ok: false, error: "token not found" });
    const revoked = await app.inject({ method: "DELETE", url: `/auth/tokens/${otherTokenId}`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(jsonBody(revoked)).toEqual({ ok: false });
    await app.close();
  });

  it("creates registration records and completes a compatible Werkzeug password", async () => {
    const databasePath = createAuthDatabase();
    const app = createApp(databasePath);
    const initial = await csrf(app);
    const requested = await app.inject({ method: "POST", url: "/auth/register", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { email: "new@example.test" } });
    expect(requested.json()).toMatchObject({ ok: true, email: "new@example.test" });
    const sqlite = new Database(databasePath);
    const token = "known-registration-token";
    sqlite.prepare("UPDATE registration_tokens SET token_hash = ? WHERE email = ?").run(hashApiToken(token), "new@example.test");
    sqlite.close();
    const completed = await app.inject({ method: "POST", url: "/auth/register/complete", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { token, password: "registration-password", password_confirm: "registration-password" } });
    expect(completed.statusCode).toBe(200);
    expect((jsonBody(completed).user as Record<string, unknown>).username).toBe("new@example.test");
    await app.close();
  });

  it("enforces registration policy, email domain, expiration, replay, and concurrent consumption", async () => {
    const databasePath = createAuthDatabase();
    const app = createApp(databasePath);
    const initial = await csrf(app);
    const closedDb = new Database(databasePath);
    closedDb.prepare("INSERT INTO store_settings(key, value) VALUES ('auth_allow_registration', 'false')").run();
    closedDb.close();
    const closed = await app.inject({ method: "POST", url: "/auth/register", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { email: "closed@example.test" } });
    expect(closed.statusCode).toBe(400);
    expect(closed.json()).toMatchObject({ ok: false, error: "registration is closed" });

    const enabledDb = new Database(databasePath);
    enabledDb.prepare("UPDATE store_settings SET value = 'true' WHERE key = 'auth_allow_registration'").run();
    enabledDb.prepare("INSERT INTO store_settings(key, value) VALUES ('auth_require_email_domain', 'example.edu')").run();
    enabledDb.close();
    const wrongDomain = await app.inject({ method: "POST", url: "/auth/register", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { email: "wrong@example.test" } });
    expect(wrongDomain.statusCode).toBe(400);
    expect(wrongDomain.json()).toMatchObject({ ok: false, error: "email must belong to example.edu" });
    const pending = await app.inject({ method: "POST", url: "/auth/register", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { email: "pending@example.edu" } });
    expect(pending.statusCode).toBe(200);
    expect(pending.body).not.toContain("prg32_");

    const token = "registration-lifecycle-token";
    const db = new Database(databasePath);
    db.prepare("UPDATE registration_tokens SET token_hash = ? WHERE email = ?").run(hashApiToken(token), "pending@example.edu");
    db.prepare("UPDATE store_settings SET value = 'false' WHERE key = 'auth_allow_registration'").run();
    db.close();
    const completedAfterDisable = await app.inject({ method: "POST", url: "/auth/register/complete", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { token, password: "registration-password", password_confirm: "registration-password" } });
    expect(completedAfterDisable.statusCode).toBe(200);
    expect((completedAfterDisable.json<{ user: { role: string } }>().user).role).toBe("user");
    const postRegistration = await csrf(app);
    const replay = await app.inject({ method: "POST", url: "/auth/register/complete", headers: { cookie: postRegistration.cookie, "x-csrftoken": postRegistration.token }, payload: { token, password: "registration-password", password_confirm: "registration-password" } });
    expect(replay.statusCode).toBe(400);

    const expiredToken = "expired-registration-token";
    const concurrentToken = "concurrent-registration-token";
    const expiredDb = new Database(databasePath);
    expiredDb.prepare("INSERT INTO registration_tokens(email, token_hash, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))").run("expired@example.edu", hashApiToken(expiredToken));
    expiredDb.prepare("INSERT INTO registration_tokens(email, token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))").run("concurrent@example.edu", hashApiToken(concurrentToken));
    expiredDb.close();
    const expired = await app.inject({ method: "POST", url: "/auth/register/complete", headers: { cookie: postRegistration.cookie, "x-csrftoken": postRegistration.token }, payload: { token: expiredToken, password: "registration-password", password_confirm: "registration-password" } });
    expect(expired.statusCode).toBe(400);
    const concurrentAuthOne = await csrf(app);
    const concurrentAuthTwo = await csrf(app);
    const concurrent = await Promise.all([
      app.inject({ method: "POST", url: "/auth/register/complete", headers: { cookie: concurrentAuthOne.cookie, "x-csrftoken": concurrentAuthOne.token }, payload: { token: concurrentToken, password: "registration-password", password_confirm: "registration-password" } }),
      app.inject({ method: "POST", url: "/auth/register/complete", headers: { cookie: concurrentAuthTwo.cookie, "x-csrftoken": concurrentAuthTwo.token }, payload: { token: concurrentToken, password: "registration-password", password_confirm: "registration-password" } })
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 400]);
    const countDb = new Database(databasePath, { readonly: true });
    expect((countDb.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'concurrent@example.edu'").get() as { count: number }).count).toBe(1);
    countDb.close();
    await app.close();
  });

  it("keeps password, role, group, and unknown-hash decisions explicit", () => {
    const valid: Principal = { authenticated: true, id: 1, name: "publisher", username: "publisher", email: "publisher@example.test", role: "publisher", groups: ["editors"], authMethod: "session" };
    expect(verifyWerkzeugPasswordHash("scrypt:32768:8:1$Sg8aDcBd0VcXm3ND$d032cc543048ff7d120b153c5af84f22d2c4592f80e9636b60069ccc532fc8d7b1147bf7340295488f2a7d0a9d61c6161ee73bef31632414a4ede2c18a100c7d", "Compat-Password-123!").status).toBe("valid");
    expect(verifyWerkzeugPasswordHash("md5$salt$digest", "password").status).toBe("unsupported");
    expect(authorizedForGroup(valid, "editors")).toBe(true);
    expect(authorizedForRole(valid, "admin")).toBe(false);
  });

  it("requires strong session and bootstrap secrets", () => {
    const databasePath = createAuthDatabase();
    const base = {
      PRG32_BACKEND_DB: path.join(path.dirname(path.dirname(databasePath)), "operational-shadow.sqlite"),
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.dirname(databasePath),
      PRG32_BACKEND_SESSION_SECRET: "test-session-secret-1234567890-abcdef",
      PRG32_BACKEND_BOOTSTRAP_TOKEN: TEST_BOOTSTRAP_TOKEN
    };
    expect(() => loadConfig({ ...base, PRG32_BACKEND_SESSION_SECRET: "too-short" })).toThrow("32 characters");
    expect(() => loadConfig({ ...base, PRG32_BACKEND_BOOTSTRAP_TOKEN: "too-short" })).toThrow("32 characters");
    expect(() => loadConfig({ PRG32_BACKEND_FEDERATION_AUTO_PROVISION: "true" })).toThrow("isolated non-production auth writer");
    expect(() => loadConfig({ ...base, NODE_ENV: "production", PRG32_BACKEND_FEDERATION_AUTO_PROVISION: "true" })).toThrow("isolated non-production auth writer");
  });

  it("expires opaque sessions and preserves cookie integrity attributes", () => {
    const store = new SessionStore("test-session-secret", 60);
    const issued = store.issue(7, 1_000);
    expect(store.get(issued.cookieValue, 59_000)?.userId).toBe(7);
    expect(store.get(issued.cookieValue, 61_001)).toBeNull();
    expect(issued.cookieValue.split(".")).toHaveLength(3);
  });

  it("does not activate auth writes in a read-only configuration", async () => {
    const app = buildApp({ config: loadConfig({ PRG32_BACKEND_DB: "/does/not/exist/store.sqlite" }), logger: false });
    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "x", password: "y" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "authentication write isolation is unavailable", code: "auth_unavailable" });
    await app.close();
  });
});
