import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { generateWerkzeugScryptHash } from "../src/auth/service.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { CatalogAdminService } from "../src/admin/catalog-service.js";

const roots: string[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];
const BOOTSTRAP = "runtime-settings-bootstrap-token-123456789";

function fixture(): { readonly root: string; readonly databasePath: string; readonly app: ReturnType<typeof buildApp>; readonly config: ReturnType<typeof loadConfig> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52g27-"));
  roots.push(root);
  const store = path.join(root, "store");
  const auth = path.join(root, "auth");
  fs.mkdirSync(store);
  fs.mkdirSync(auth);
  const databasePath = path.join(auth, "auth.sqlite");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT, disabled_at TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO groups(name) VALUES ('editors');
  `);
  db.close();
  fs.writeFileSync(path.join(store, "index.json"), JSON.stringify({ abi: "prg32-cartridge-store-index-1.0", games: {} }));
  const shadow = path.join(root, "shadow.sqlite");
  fs.writeFileSync(shadow, "shadow");
  const config = loadConfig({
    PRG32_BACKEND_DB: shadow,
    PRG32_BACKEND_STORE_DATA: store,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: databasePath,
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: auth,
    PRG32_BACKEND_SESSION_SECRET: "runtime-settings-session-secret-123456789",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false"
    ,PRG32_BACKEND_EMAIL_TRANSPORT: "memory"
    ,PRG32_BACKEND_EMAIL_PUBLIC_ORIGIN: "https://store.prg32.test"
    ,PRG32_BACKEND_SETUP_NETWORK_TEST_ALLOWLIST: "127.0.0.1"
  });
  const app = buildApp({ config, logger: false });
  apps.push(app);
  return { root, databasePath, app, config };
}

function header(response: { readonly headers: Record<string, string | string[] | undefined> }, key: string): string {
  const value = response.headers[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function adminSession(app: ReturnType<typeof buildApp>): Promise<{ readonly cookie: string; readonly csrf: string; readonly id: number }> {
  const response = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": BOOTSTRAP }, payload: { username: "runtime-admin", email: "runtime-admin@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
  expect(response.statusCode).toBe(201);
  const cookie = header(response, "set-cookie").split(";", 1)[0] ?? "";
  const csrf = (await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie } })).json<{ csrf_token: string }>().csrf_token;
  return { cookie, csrf, id: response.json<{ user: { id: number } }>().user.id };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical administration and runtime configuration", () => {
  it("persists typed settings without exposing secret values and records SQLite audit evidence", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const response = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: {
      application_settings: {
        "application.store_description": "Disposable administration fixture",
        "registration.enabled": false,
        "smtp.host": "mailpit",
        "smtp.port": 1025,
        "smtp.encryption": "none",
        "smtp.password": "must-not-leak"
      }
    } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("must-not-leak");

    const valid = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: {
      application_settings: { "application.store_description": "Disposable administration fixture", "registration.enabled": false, "smtp.host": "mailpit", "smtp.port": 1025, "smtp.encryption": "none" }
    } });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ application_settings: { "registration.enabled": { value: false }, "smtp.host": { value: "mailpit" } } });
    expect(valid.body).not.toContain("must-not-leak");

    const repeated = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: {
      application_settings: { "application.store_description": "Disposable administration fixture", "registration.enabled": false, "smtp.host": "mailpit", "smtp.port": 1025, "smtp.encryption": "none", "publishing.enabled": false }
    } });
    expect(repeated.statusCode).toBe(200);

    const db = new Database(test.databasePath, { readonly: true });
    expect(db.prepare("SELECT value_json FROM application_settings WHERE setting_key = 'registration.enabled'").get()).toEqual({ value_json: "false" });
    const latestAudit = db.prepare("SELECT summary_json FROM admin_audit_events WHERE action = 'settings.update' ORDER BY timestamp DESC, event_id DESC LIMIT 1").get() as { summary_json: string };
    expect(JSON.parse(latestAudit.summary_json)).toMatchObject({
      keys: ["publishing.enabled"],
      changes: [{ key: "publishing.enabled", before: true, after: false }],
    });
    db.close();
  });

  it("suspends and bans users through the canonical status API and revokes bearer access", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const db = new Database(test.databasePath);
    const user = db.prepare("INSERT INTO users(username, email, password_hash, role) VALUES (?, ?, ?, 'user')").run("runtime-user", "runtime-user@example.test", generateWerkzeugScryptHash("long-password-123"));
    const userId = Number(user.lastInsertRowid);
    const token = "runtime-user-api-token";
    db.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(userId, hashApiToken(token), "runtime test");
    db.close();

    const changed = await test.app.inject({ method: "PATCH", url: `/api/admin/users/${userId}/status`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { status: "suspended", reason: "manual review" } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ user: { account_status: "suspended", status_reason: "manual review" } });
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);

    const restored = await test.app.inject({ method: "PATCH", url: `/api/admin/users/${userId}/status`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { status: "active" } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ user: { account_status: "active" } });
  });

  it("keeps hide, unpublish, and restore as distinct canonical moderation events", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const db = new Database(test.databasePath);
    const service = new CatalogAdminService({ config: test.config, publication: null, moderationDatabase: db, catalog: {} as never });
    expect(service.moderate({ gameId: "org.example.runtime", version: "1.0.0", action: "hidden", reason: "policy review" }, { actorUserId: admin.id, requestId: "moderation-1" })).toMatchObject({ action: "hidden" });
    expect(service.moderate({ gameId: "org.example.runtime", version: "1.0.0", action: "unpublished", reason: "withdrawn" }, { actorUserId: admin.id, requestId: "moderation-2" })).toMatchObject({ action: "unpublished" });
    expect(service.moderate({ gameId: "org.example.runtime", version: "1.0.0", action: "restored" }, { actorUserId: admin.id, requestId: "moderation-3" })).toMatchObject({ action: "restored" });
    expect(db.prepare("SELECT action, active FROM catalog_moderation WHERE cartridge_id = ? AND version = ? ORDER BY moderation_id").all("org.example.runtime", "1.0.0")).toEqual([{ action: "hidden", active: 0 }, { action: "unpublished", active: 0 }, { action: "restored", active: 1 }]);
    db.close();
  });

  it("enforces persisted registration/session policy and rejects stale settings versions", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const disabled = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: {
      application_settings: { "registration.enabled": false, "session.lifetime_seconds": 60 }
    } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ application_settings: { "registration.enabled": { value: false, version: 1 }, "session.lifetime_seconds": { value: 60, version: 1 } } });

    const csrf = await test.app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie: admin.cookie } });
    const rejected = await test.app.inject({ method: "POST", url: "/api/auth/register", headers: { cookie: admin.cookie, "x-csrftoken": csrf.json<{ csrf_token: string }>().csrf_token }, payload: { username: "closed-user", email: "closed-user@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain("registration_tokens");

    const enabled = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: {
      expected_versions: { "registration.enabled": 1 },
      application_settings: { "registration.enabled": true }
    } });
    expect(enabled.statusCode).toBe(200);
    const stale = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: {
      expected_versions: { "registration.enabled": 1 },
      application_settings: { "registration.enabled": false }
    } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ ok: false, code: "settings_conflict" });

    const registrationCsrf = await test.app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie: admin.cookie } });
    const accepted = await test.app.inject({ method: "POST", url: "/api/auth/register", headers: { cookie: admin.cookie, "x-csrftoken": registrationCsrf.json<{ csrf_token: string }>().csrf_token }, payload: { username: "open-user", email: "open-user@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
    expect(accepted.statusCode).toBe(200);
    const loginCsrf = await test.app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie: admin.cookie } });
    const login = await test.app.inject({ method: "POST", url: "/auth/login", headers: { cookie: admin.cookie, "x-csrftoken": loginCsrf.json<{ csrf_token: string }>().csrf_token }, payload: { username: "runtime-admin", password: "long-password-123" } });
    expect(login.statusCode).toBe(200);
    expect(header(login, "set-cookie")).toContain("Max-Age=60");

    const db = new Database(test.databasePath, { readonly: true });
    const session = db.prepare("SELECT expires_at, created_at FROM auth_sessions ORDER BY rowid DESC LIMIT 1").get() as { expires_at: number; created_at: number };
    expect(session.expires_at - session.created_at).toBe(60000);
    db.close();
  });

  it("reloads persisted SMTP settings after restart and submits a synthetic test message", async () => {
    const smtp = net.createServer((socket) => {
      let data = "";
      let inData = false;
      socket.on("error", () => undefined);
      const reply = (value: string) => setTimeout(() => socket.write(value), 1);
      socket.write("220 disposable smtp\r\n");
      socket.on("data", (chunk) => {
        if (inData) {
          data += chunk.toString("utf8");
          const end = data.indexOf("\r\n.\r\n");
          if (end >= 0) { data = data.slice(end + 5); inData = false; reply("250 accepted\r\n"); }
          return;
        }
        data += chunk.toString("utf8");
        while (data.includes("\r\n")) {
          const separator = data.indexOf("\r\n");
          const line = data.slice(0, separator);
          data = data.slice(separator + 2);
          if (line.toUpperCase().startsWith("EHLO")) reply("250-disposable\r\n250 OK\r\n");
          else if (line.toUpperCase().startsWith("DATA")) {
            inData = true;
            reply("354 end with dot\r\n");
            const end = data.indexOf("\r\n.\r\n");
            if (end >= 0) { data = data.slice(end + 5); inData = false; reply("250 accepted\r\n"); }
            return;
          }
          else if (line.toUpperCase().startsWith("QUIT")) { reply("221 bye\r\n"); setTimeout(() => socket.end(), 2); }
          else reply("250 OK\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", () => resolve()));
    const port = (smtp.address() as net.AddressInfo).port;
    const test = fixture();
    const admin = await adminSession(test.app);
    const saved = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: {
      application_settings: { "smtp.enabled": true, "smtp.host": "127.0.0.1", "smtp.port": port, "smtp.encryption": "none", "smtp.from_email": "store@example.test" }
    } });
    expect(saved.statusCode).toBe(200);
    await test.app.close();
    const restarted = buildApp({ config: test.config, logger: false });
    apps.push(restarted);
    const anonymousCsrf = await restarted.inject({ method: "GET", url: "/auth/csrf" });
    const anonymousCookie = header(anonymousCsrf, "set-cookie").split(";", 1)[0] ?? "";
    const login = await restarted.inject({ method: "POST", url: "/auth/login", headers: { cookie: anonymousCookie, "x-csrftoken": anonymousCsrf.json<{ csrf_token: string }>().csrf_token }, payload: { username: "runtime-admin", password: "long-password-123" } });
    expect(login.statusCode).toBe(200);
    const reauthCookie = header(login, "set-cookie").split(";", 1)[0] ?? "";
    const reauthCsrf = await restarted.inject({ method: "GET", url: "/auth/csrf", headers: { cookie: reauthCookie } });
    const connection = await restarted.inject({ method: "POST", url: "/api/admin/settings/smtp/test-connection", headers: { cookie: reauthCookie, "x-csrftoken": reauthCsrf.json<{ csrf_token: string }>().csrf_token } });
    expect(connection.statusCode).toBe(200);
    const settings = await restarted.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie: reauthCookie } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ application_settings: { "smtp.enabled": { value: true }, "smtp.host": { value: "127.0.0.1" } } });
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  });
});
