import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const roots: string[] = [];
const bootstrapToken = "federation-admin-bootstrap-token-123456789";
const password = "admin-local-password-123";

function databasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-federation-admin-"));
  roots.push(root);
  const disposable = path.join(root, "disposable");
  fs.mkdirSync(disposable);
  const database = path.join(disposable, "auth.sqlite");
  const sqlite = new Database(database);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO groups(name) VALUES ('editors');
  `);
  sqlite.close();
  return database;
}

function appFor(database: string) {
  const shadow = path.join(path.dirname(path.dirname(database)), "shadow.sqlite");
  fs.closeSync(fs.openSync(shadow, "a"));
  return buildApp({
    config: loadConfig({
      PRG32_BACKEND_DB: shadow,
      PRG32_BACKEND_STORE_DATA: path.dirname(database),
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: database,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.dirname(database),
      PRG32_BACKEND_SESSION_SECRET: "federation-admin-session-secret-123456789",
      PRG32_BACKEND_BOOTSTRAP_TOKEN: bootstrapToken,
      PRG32_BACKEND_SESSION_SECURE: "false"
    }),
    logger: false
  });
}

function publicKey(): string {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" }
  }).publicKey;
}

function header(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native federation administration boundary", () => {
  it("fails closed for lifecycle-test activation without isolated prerequisites", () => {
    expect(() => loadConfig({ PRG32_BACKEND_FEDERATION_LIFECYCLE_TEST_ENABLED: "true" })).toThrow(/lifecycle test routes require/);
    expect(() => loadConfig({ NODE_ENV: "production", PRG32_BACKEND_FEDERATION_LIFECYCLE_TEST_ENABLED: "true", PRG32_BACKEND_FEDERATION_LIFECYCLE_TEST_TOKEN: "x".repeat(40), PRG32_BACKEND_AUTH_WRITE_ENABLED: "true", PRG32_BACKEND_AUTH_WRITE_MODE: "test", PRG32_BACKEND_AUTH_WRITE_DB: "/tmp/auth.sqlite", PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: "/tmp/auth-root", PRG32_BACKEND_SESSION_SECRET: "federation-admin-session-secret-123456789" })).toThrow(/cannot be enabled in production/);
  });

  it("requires local session, CSRF, and recent password reauthentication", async () => {
    const app = appFor(databasePath());
    const boot = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": bootstrapToken }, payload: { username: "admin", email: "admin@example.test", password, password_confirm: password } });
    const sessionCookie = cookie(boot);
    const csrfResponse = await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie: sessionCookie } });
    const csrf = csrfResponse.json<{ csrf_token: string }>().csrf_token;

    expect((await app.inject({ method: "GET", url: "/api/admin/federation/providers" })).statusCode).toBe(401);
    const missingReauth = await app.inject({ method: "POST", url: "/api/admin/federation/providers", headers: { cookie: sessionCookie, "x-csrftoken": csrf }, payload: { provider_id: "campus", protocol: "oidc", display_name: "Campus", issuer: "https://id.example.test", client_id: "client", redirect_uri: "https://store.example.test/api/auth/oidc/campus/callback" } });
    expect(missingReauth.json()).toMatchObject({ code: "recent_reauthentication_required" });

    const reauth = await app.inject({ method: "POST", url: "/api/admin/federation/reauthenticate", headers: { cookie: sessionCookie, "x-csrftoken": csrf }, payload: { password } });
    expect(reauth.statusCode).toBe(200);
    const created = await app.inject({ method: "POST", url: "/api/admin/federation/providers", headers: { cookie: sessionCookie, "x-csrftoken": csrf }, payload: { provider_id: "campus", protocol: "oidc", display_name: "Campus", issuer: "https://id.example.test", client_id: "client", redirect_uri: "https://store.example.test/api/auth/oidc/campus/callback", scopes: ["openid"] } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ok: true, provider: { provider_id: "campus", protocol: "oidc", enabled: false } });
    expect(created.json<{ provider: Record<string, unknown> }>().provider).not.toHaveProperty("client_secret");

    const enabled = await app.inject({ method: "POST", url: "/api/admin/federation/providers/campus/enable", headers: { cookie: sessionCookie, "x-csrftoken": csrf } });
    expect(enabled.statusCode).toBe(200);
    const listed = await app.inject({ method: "GET", url: "/api/admin/federation/providers", headers: { cookie: sessionCookie } });
    expect(listed.json<{ providers: Array<{ provider_id: string; enabled: boolean }> }>().providers).toEqual([expect.objectContaining({ provider_id: "campus", enabled: true })]);

    const saml = await app.inject({ method: "POST", url: "/api/admin/federation/providers", headers: { cookie: sessionCookie, "x-csrftoken": csrf }, payload: { provider_id: "campus-saml", protocol: "saml", display_name: "Campus SAML", issuer: "https://id.example.test/saml", idp_entity_id: "https://id.example.test/saml", sp_entity_id: "https://store.example.test/sp", acs_url: "https://store.example.test/api/auth/saml/campus-saml/acs", saml_entry_point: "https://id.example.test/sso", saml_name_id_format: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", saml_idp_certificate_pem: publicKey() } });
    expect(saml.statusCode).toBe(201);
    const linked = await app.inject({ method: "POST", url: "/api/admin/federation/identities", headers: { cookie: sessionCookie, "x-csrftoken": csrf }, payload: { protocol: "oidc", provider_id: "campus", issuer: "https://id.example.test/", subject: "admin-subject", user_id: 1 } });
    expect(linked.statusCode).toBe(201);
    const identityId = linked.json<{ identity: { identityId: number } }>().identity.identityId;
    const identities = await app.inject({ method: "GET", url: "/api/admin/federation/identities", headers: { cookie: sessionCookie } });
    expect(identities.json<{ identities: Array<{ id: number; subject: string }> }>().identities).toEqual(expect.arrayContaining([expect.objectContaining({ id: identityId, subject: "admin-subject" })]));
    const retired = await app.inject({ method: "POST", url: `/api/admin/federation/identities/${identityId}/retire`, headers: { cookie: sessionCookie, "x-csrftoken": csrf } });
    expect(retired.statusCode).toBe(200);
    await app.close();
  });

  it("does not expose token-only lifecycle routes unless explicitly enabled", async () => {
    const app = appFor(databasePath());
    const response = await app.inject({ method: "GET", url: "/_test/federation/providers/campus", headers: { "x-prg32-federation-lifecycle-token": "x".repeat(40) } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
