import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { SettingsError, SettingsService } from "../src/settings/service.js";

const roots: string[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];
const BOOTSTRAP = "settings-bootstrap-token-1234567890";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function createDatabase(): { readonly root: string; readonly databasePath: string; readonly storeRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m63d2b-"));
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
    INSERT INTO store_settings(key, value) VALUES
      ('store_name', 'Compatibility Store'),
      ('smtp_password', 'must-never-be-returned'),
      ('oidc_client_secret', 'must-never-be-returned'),
      ('unknown_legacy_key', 'must-remain-untouched');
  `);
  db.close();
  fs.writeFileSync(path.join(storeRoot, "index.json"), JSON.stringify({ abi: "prg32-cartridge-store-index-1.0", games: {} }));
  return { root, databasePath, storeRoot };
}

function fixture(options: Record<string, string | undefined> = {}) {
  const paths = createDatabase();
  const shadow = path.join(paths.root, "shadow.sqlite");
  fs.writeFileSync(shadow, Buffer.from("shadow"));
  const config = loadConfig({
    PRG32_BACKEND_DB: shadow,
    PRG32_BACKEND_STORE_DATA: paths.storeRoot,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: paths.databasePath,
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.join(paths.root, "auth-workspace"),
    PRG32_BACKEND_SESSION_SECRET: "settings-session-secret-1234567890",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false",
    ...options
  });
  const app = buildApp({ config, logger: false });
  apps.push(app);
  return { app, config, ...paths };
}

function header(response: { readonly headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
  return value as Record<string, unknown>;
}

function jsonObject(response: { json<T = unknown>(): T }): Record<string, unknown> {
  return record(response.json<unknown>());
}

function responseCode(response: { json<T = unknown>(): T }): unknown {
  return jsonObject(response).code;
}

function settingValue(response: { json<T = unknown>(): T }, key: string): unknown {
  const settings = record(jsonObject(response).settings);
  return record(settings[key]).value;
}

function assetUrl(response: { json<T = unknown>(): T }): string {
  const asset = record(jsonObject(response).asset).url;
  if (typeof asset !== "string") throw new Error("expected asset URL");
  return asset;
}

async function adminSession(app: ReturnType<typeof buildApp>): Promise<{ readonly cookie: string; readonly csrf: string; readonly userId: number }> {
  const bootstrap = await app.inject({
    method: "POST",
    url: "/auth/bootstrap",
    headers: { "x-prg32-bootstrap-token": BOOTSTRAP },
    payload: { username: "settings-admin", email: "settings-admin@example.test", password: "long-password-123", password_confirm: "long-password-123" }
  });
  expect(bootstrap.statusCode).toBe(201);
  const cookie = header(bootstrap, "set-cookie").split(";", 1)[0] ?? "";
  const csrfResponse = await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie } });
  return { cookie, csrf: csrfResponse.json<{ csrf_token: string }>().csrf_token, userId: bootstrap.json<{ user: { id: number } }>().user.id };
}

function multipart(bytes: Uint8Array, csrf = ""): { readonly body: Buffer; readonly contentType: string } {
  const boundary = "----prg32-m63d2b-boundary";
  const prefix = csrf
    ? `--${boundary}\r\nContent-Disposition: form-data; name="csrf_token"\r\n\r\n${csrf}\r\n`
    : "";
  return {
    body: Buffer.concat([
      Buffer.from(prefix),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="asset"; filename="asset.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("settings API", () => {
  it("requires an administrator and redacts excluded legacy settings", async () => {
    const test = fixture();
    expect((await test.app.inject({ method: "GET", url: "/api/admin/settings" })).statusCode).toBe(401);
    const admin = await adminSession(test.app);
    const response = await test.app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie: admin.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      settings: { store_name: { value: "Compatibility Store", writable: true }, auth_allow_registration: { value: true, writable: true } },
      read_only: { auth_default_role: { value: "user" } }
    });
    expect(response.body).not.toContain("smtp_password");
    expect(response.body).not.toContain("oidc_client_secret");
    expect(response.body).not.toContain("unknown_legacy_key");

    const db = new Database(test.databasePath);
    const userToken = "prg32-settings-user-token";
    const user = db.prepare("INSERT INTO users(username, email, role) VALUES (?, ?, 'user')").run("settings-user", "settings-user@example.test");
    db.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(Number(user.lastInsertRowid), hashApiToken(userToken), "settings user test");
    db.close();
    const nonAdmin = await test.app.inject({ method: "GET", url: "/api/admin/settings", headers: { authorization: `Bearer ${userToken}` } });
    expect(nonAdmin.statusCode).toBe(403);
    expect(responseCode(nonAdmin)).toBe("admin_required");
  });

  it("supports atomic allow-listed patches and rejects invalid or bearer mutations", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const valid = await test.app.inject({
      method: "PATCH",
      url: "/api/admin/settings",
      headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf },
      payload: { store_name: "New Store", theme_primary_color: "#AABBCC", theme_font_family: "Inter, ui-sans-serif, system-ui, sans-serif", auth_allow_registration: false }
    });
    expect(valid.statusCode).toBe(200);
    expect(record(jsonObject(valid).settings)).toMatchObject({
      store_name: { value: "New Store" },
      theme_primary_color: { value: "#aabbcc" },
      theme_font_family: { value: "Inter, ui-sans-serif, system-ui, sans-serif" },
      auth_allow_registration: { value: false }
    });

    const invalid = await test.app.inject({
      method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf },
      payload: { store_name: "Should Not Persist", theme_primary_color: "red" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(responseCode(invalid)).toBe("settings_invalid_value");
    const unchanged = await test.app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie: admin.cookie } });
    expect(settingValue(unchanged, "store_name")).toBe("New Store");

    for (const [key, code] of [["unknown", "settings_unknown_key"], ["auth_default_role", "settings_read_only"], ["smtp_host", "settings_excluded"], ["theme_logo_url", "settings_asset_managed"]] as const) {
      const payload = key === "unknown" ? { unknown: "x" } : { [key]: "x" };
      const response = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload });
      expect(response.statusCode).toBe(400);
      expect(responseCode(response)).toBe(code);
    }

    const noCsrf = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie }, payload: { store_name: "nope" } });
    expect(noCsrf.statusCode).toBe(403);
    expect(responseCode(noCsrf)).toBe("csrf_failed");

    const token = "prg32-settings-admin-token";
    const db = new Database(test.databasePath);
    db.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(admin.userId, hashApiToken(token), "settings test");
    db.close();
    const bearerMutation = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { authorization: `Bearer ${token}` }, payload: { store_name: "nope" } });
    expect(bearerMutation.statusCode).toBe(403);
    expect(responseCode(bearerMutation)).toBe("settings_browser_session_required");
  });

  it("persists settings across service restart and remains disabled without a writer", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const patch = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { store_tagline: "Persistent" } });
    expect(patch.statusCode).toBe(200);
    await test.app.close();
    apps.splice(apps.indexOf(test.app), 1);

    const reopened = buildApp({ config: test.config, logger: false });
    apps.push(reopened);
    const db = new Database(test.databasePath);
    const token = "prg32-settings-restart-token";
    db.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(admin.userId, hashApiToken(token), "restart test");
    db.close();
    const response = await reopened.inject({ method: "GET", url: "/api/admin/settings", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(settingValue(response, "store_tagline")).toBe("Persistent");

    const disabled = fixture({ PRG32_BACKEND_AUTH_WRITE_ENABLED: "false", PRG32_BACKEND_AUTH_WRITE_DB: undefined });
    expect(responseCode(await disabled.app.inject({ method: "PATCH", url: "/api/admin/settings", payload: { store_name: "nope" } }))).toBe("settings_unavailable");
  });

  it("explains that SMTP must be enabled before a connection test", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const response = await test.app.inject({
      method: "POST",
      url: "/api/admin/settings/smtp/test-connection",
      headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      ok: false,
      code: "smtp_disabled",
      error: "SMTP delivery is disabled; enable SMTP and save settings first",
    });
  });

  it("validates, serves, replaces, and safely rolls back managed assets", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const upload = multipart(PNG, admin.csrf);
    const first = await test.app.inject({ method: "POST", url: "/api/admin/settings/assets/logo", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf, "content-type": upload.contentType }, payload: upload.body });
    expect(first.statusCode).toBe(200);
    const firstUrl = assetUrl(first);
    const served = await test.app.inject({ method: "GET", url: firstUrl });
    expect(served.statusCode).toBe(200);
    expect(header(served, "content-type")).toContain("image/webp");
    expect(served.rawPayload).not.toEqual(PNG);

    const svg = multipart(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), admin.csrf);
    const rejected = await test.app.inject({ method: "POST", url: "/api/admin/settings/assets/logo", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf, "content-type": svg.contentType }, payload: svg.body });
    expect(rejected.statusCode).toBe(400);
    expect(responseCode(rejected)).toBe("asset_invalid_type");
    expect((await test.app.inject({ method: "GET", url: firstUrl })).statusCode).toBe(200);

    const tooLarge = multipart(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]), admin.csrf);
    const oversized = await test.app.inject({ method: "POST", url: "/api/admin/settings/assets/logo", headers: { cookie: admin.cookie, "content-type": tooLarge.contentType }, payload: tooLarge.body });
    expect(oversized.statusCode).toBe(413);
    expect(responseCode(oversized)).toBe("asset_too_large");

    const replacement = multipart(PNG, admin.csrf);
    const second = await test.app.inject({ method: "POST", url: "/api/admin/settings/assets/logo", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf, "content-type": replacement.contentType }, payload: replacement.body });
    expect(second.statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: firstUrl })).statusCode).toBe(404);
    expect((await test.app.inject({ method: "GET", url: assetUrl(second) })).statusCode).toBe(200);

    const missingCsrfUpload = multipart(PNG);
    const missingCsrf = await test.app.inject({ method: "POST", url: "/api/admin/settings/assets/favicon", headers: { cookie: admin.cookie, "content-type": missingCsrfUpload.contentType }, payload: missingCsrfUpload.body });
    expect(missingCsrf.statusCode).toBe(403);
    expect(responseCode(missingCsrf)).toBe("csrf_failed");

    const faviconUpload = multipart(Buffer.from([0, 0, 1, 0, 1, 0]), admin.csrf);
    const favicon = await test.app.inject({ method: "POST", url: "/api/admin/settings/assets/favicon", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf, "content-type": faviconUpload.contentType }, payload: faviconUpload.body });
    expect(favicon.statusCode).toBe(200);
    expect(jsonObject(favicon).asset).toMatchObject({ kind: "favicon", mime_type: "image/x-icon", size: 6 });
    const faviconResponse = await test.app.inject({ method: "GET", url: assetUrl(favicon) });
    expect(faviconResponse.statusCode).toBe(200);
    expect(header(faviconResponse, "content-type")).toContain("image/x-icon");

    const webpInput = await sharp(PNG).webp().toBuffer();
    const webpUpload = multipart(webpInput, admin.csrf);
    const webp = await test.app.inject({ method: "POST", url: "/api/admin/settings/assets/logo", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf, "content-type": webpUpload.contentType }, payload: webpUpload.body });
    expect(webp.statusCode).toBe(200);
    expect(jsonObject(webp).asset).toMatchObject({ kind: "logo", mime_type: "image/webp" });
    expect(Number(record(jsonObject(webp).asset).size)).toBeGreaterThan(0);
    const webpResponse = await test.app.inject({ method: "GET", url: assetUrl(webp) });
    expect(webpResponse.statusCode).toBe(200);
    expect(header(webpResponse, "content-type")).toContain("image/webp");

    const faultRoot = path.join(test.root, "fault-assets");
    const db = new Database(test.databasePath);
    const previousRef = (db.prepare("SELECT value FROM store_settings WHERE key = 'theme_logo_url'").get() as { value: string }).value;
    const service = new SettingsService({
      config: test.config,
      database: db,
      writableDatabase: db,
      assetDirectory: faultRoot,
      fault: (point) => { if (point === "after-asset-publish") throw new Error("synthetic fault"); }
    });
    await expect(service.replaceAsset("logo", PNG)).rejects.toThrowError(SettingsError);
    expect((db.prepare("SELECT value FROM store_settings WHERE key = 'theme_logo_url'").get() as { value: string }).value).toBe(previousRef);
    expect(fs.readdirSync(faultRoot).filter((name) => name.startsWith(".staging-") || name.startsWith("logo-")).length).toBe(0);
    db.close();
  });
});
