import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { parseSamlMetadata } from "../src/setup/provider-validation.js";

const roots: string[] = [];
const BOOTSTRAP = "webauthn-test-bootstrap-token-1234567890";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-webauthn-")); roots.push(root);
  const authRoot = path.join(root, "auth"); fs.mkdirSync(authRoot);
  const databasePath = path.join(authRoot, "auth.sqlite");
  fs.closeSync(fs.openSync(path.join(root, "shadow.sqlite"), "a"));
  const db = new Database(databasePath);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT); CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT); CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY (user_id, group_id)); CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT); CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.close();
  const config = loadConfig({ NODE_ENV: "test", PRG32_BACKEND_DB: path.join(root, "shadow.sqlite"), PRG32_BACKEND_STORE_DATA: root, PRG32_BACKEND_AUTH_WRITE_ENABLED: "true", PRG32_BACKEND_AUTH_WRITE_MODE: "test", PRG32_BACKEND_AUTH_WRITE_DB: databasePath, PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: authRoot, PRG32_BACKEND_SESSION_SECRET: "webauthn-test-session-secret-long-enough-123", PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP, PRG32_BACKEND_SESSION_SECURE: "false", PRG32_BACKEND_WEBAUTHN_ENABLED: "true", PRG32_BACKEND_WEBAUTHN_RP_ID: "localhost", PRG32_BACKEND_WEBAUTHN_ORIGINS: "http://localhost" });
  return { databasePath, app: buildApp({ config, logger: false }) };
}

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"]; return `${Array.isArray(value) ? value[0] ?? "" : value ?? ""}`.split(";", 1)[0] ?? "";
}

async function csrf(app: ReturnType<typeof buildApp>, currentCookie = "") {
  const response = await app.inject({ method: "GET", url: "/auth/csrf", headers: currentCookie ? { cookie: currentCookie } : {} });
  return { token: response.json<{ csrf_token: string }>().csrf_token, cookie: currentCookie || cookie(response) };
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("WebAuthn containment", () => {
  it("fails closed for missing RP/origin configuration", () => {
    expect(() => loadConfig({ PRG32_BACKEND_WEBAUTHN_ENABLED: "true", PRG32_BACKEND_AUTH_WRITE_ENABLED: "false" })).toThrow(/WebAuthn requires/iu);
    expect(() => loadConfig({ NODE_ENV: "test", PRG32_BACKEND_WEBAUTHN_ENABLED: "true", PRG32_BACKEND_AUTH_WRITE_ENABLED: "true", PRG32_BACKEND_WEBAUTHN_RP_ID: "api.example.test", PRG32_BACKEND_WEBAUTHN_ORIGINS: "https://store.example.test" })).toThrow(/compatible/iu);
    expect(() => loadConfig({ NODE_ENV: "test", PRG32_BACKEND_WEBAUTHN_ENABLED: "true", PRG32_BACKEND_AUTH_WRITE_ENABLED: "true", PRG32_BACKEND_WEBAUTHN_RP_ID: "example.test", PRG32_BACKEND_WEBAUTHN_ORIGINS: "https://store.example.test/path" })).toThrow(/origins/iu);
  });

  it("creates canonical challenge rows and rejects anonymous, CSRF and malformed ceremonies", async () => {
    const test = fixture(); const app = test.app;
    const bootstrap = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": BOOTSTRAP }, payload: { username: "admin", email: "admin@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
    expect(bootstrap.statusCode).toBe(201);
    const sessionCookie = cookie(bootstrap); const token = (await csrf(app, sessionCookie)).token;
    const noCsrf = await app.inject({ method: "POST", url: "/auth/passkeys/register/options", headers: { cookie: sessionCookie }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
    const reauth = await app.inject({ method: "POST", url: "/auth/reauthenticate", headers: { cookie: sessionCookie, "x-csrftoken": token }, payload: { password: "long-password-123" } });
    expect(reauth.statusCode).toBe(200);
    const options = await app.inject({ method: "POST", url: "/auth/passkeys/register/options", headers: { cookie: sessionCookie, "x-csrftoken": token }, payload: {} });
    expect(options.statusCode).toBe(200);
    expect(options.json<{ options: { challenge: string; rp: { id?: string } } }>().options).toMatchObject({ rp: { id: "localhost" } });
    const malformed = await app.inject({ method: "POST", url: "/auth/passkeys/register", headers: { cookie: sessionCookie, "x-csrftoken": token }, payload: { response: { id: "A".repeat(20) } } });
    expect(malformed.statusCode).toBe(400);
    const db = new Database(test.databasePath, { readonly: true });
    expect((db.prepare("SELECT ceremony, consumed_at FROM webauthn_challenges").all() as Array<{ ceremony: string; consumed_at: number | null }>)).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('webauthn_credentials', 'webauthn_challenges') ORDER BY name").all()).toEqual([{ name: "webauthn_challenges" }, { name: "webauthn_credentials" }]);
    db.close(); await app.close();
  });

  it("rejects unsafe SAML metadata before parsing and extracts safe metadata fields", () => {
    expect(() => parseSamlMetadata("<!DOCTYPE foo [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><EntityDescriptor />")).toThrow(/invalid/iu);
    const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { format: "der", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } });
    const xml = `<EntityDescriptor entityID="https://idp.example.test/metadata" xmlns="urn:oasis:names:tc:SAML:2.0:metadata"><IDPSSODescriptor><KeyDescriptor use="signing"><KeyInfo><X509Data><X509Certificate>${keys.publicKey.toString("base64")}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.test/sso" /></IDPSSODescriptor></EntityDescriptor>`;
    expect(parseSamlMetadata(xml)).toMatchObject({ idp_entity_id: "https://idp.example.test/metadata", saml_entry_point: "https://idp.example.test/sso", metadata_validated: true });
  });
});
