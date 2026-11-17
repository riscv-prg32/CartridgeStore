import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { generateWerkzeugScryptHash } from "../src/auth/service.js";
import { initializeDisposableStorage } from "../src/storage-v2/database.js";
import { CANONICAL_READ_AUTHORIZATION, CANONICAL_WRITE_AUTHORIZATION } from "../src/storage-v2/read-mode.js";
import { CANDIDATE_RUNTIME_AUTHORIZATION } from "../src/runtime/candidate.js";
import { generateRegistryDocument } from "../src/secrets/registry.js";

const roots: string[] = [];
const BOOTSTRAP = "m537-installation-bootstrap-token-1234567890";

function fixture(options: { readonly seedAdmin?: boolean } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m537-setup-"));
  roots.push(parent);
  const root = path.join(parent, "canonical");
  const keyRegistryPath = path.join(parent, "setup-keys.json");
  fs.writeFileSync(keyRegistryPath, generateRegistryDocument("m537-test-key"), { mode: 0o600 });
  fs.chmodSync(keyRegistryPath, 0o600);
  const storage = initializeDisposableStorage(root);
  if (options.seedAdmin) storage.sqlite.prepare("INSERT INTO users(id, username, email, password_hash, role, created_at) VALUES (1, 'existing-admin', 'existing-admin@example.test', ?, 'admin', ?)").run(generateWerkzeugScryptHash("existing-admin-password"), new Date().toISOString());
  storage.close();
  const config = loadConfig({
    NODE_ENV: "test",
    PRG32_BACKEND_DB: path.join(root, "store.sqlite"),
    PRG32_BACKEND_STORE_DATA: root,
    PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: root,
    PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: CANONICAL_READ_AUTHORIZATION,
    PRG32_BACKEND_CANONICAL_WORKFLOW_MODE: "disposable",
    PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION: CANONICAL_WRITE_AUTHORIZATION,
    PRG32_BACKEND_CANDIDATE_MODE: "two-service-disposable",
    PRG32_BACKEND_CANDIDATE_AUTHORIZATION: CANDIDATE_RUNTIME_AUTHORIZATION,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: path.join(root, "store.sqlite"),
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: root,
    PRG32_BACKEND_SESSION_SECRET: "m537-setup-session-secret-0123456789",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SECRET_ENCRYPTION_ENABLED: "true",
    PRG32_BACKEND_SECRET_KEY_REGISTRY: keyRegistryPath,
    PRG32_BACKEND_SESSION_SECURE: "false",
    PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN: "https://store.prg32.test",
    PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN: "https://api.prg32.test"
  });
  return { root, app: buildApp({ config, logger: false }) };
}

function cookie(response: { headers: Record<string, string | string[] | undefined> }, name = "prg32_setup_session"): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";", 1)[0] ?? "";
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("first installation setup", () => {
  it("authorizes a fresh installation, persists every step, completes once, and survives restart", async () => {
    const test = fixture();
    const status = await test.app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: "INSTALLATION_REQUIRED", setup_required: true, infrastructure: { ready: true } });

    const rejected = await test.app.inject({ method: "POST", url: "/api/setup/authorize", payload: { bootstrap_token: "wrong" } });
    expect(rejected.statusCode).toBe(403);
    const authorized = await test.app.inject({ method: "POST", url: "/api/setup/authorize", payload: { bootstrap_token: BOOTSTRAP } });
    expect(authorized.statusCode).toBe(200);
    const setupCookie = cookie(authorized);
    const csrf = authorized.json<{ csrf_token: string }>().csrf_token;
    expect(setupCookie).toContain("prg32_setup_session=");
    expect(csrf).toHaveLength(43);

    const noCsrf = await test.app.inject({ method: "POST", url: "/api/setup/progress", headers: { cookie: setupCookie }, payload: { step: "admin", payload: {} } });
    expect(noCsrf.statusCode).toBe(403);
    const admin = await test.app.inject({ method: "POST", url: "/api/setup/progress", headers: { cookie: setupCookie, "x-csrftoken": csrf }, payload: { step: "admin", payload: { username: "first-admin", email: "first-admin@example.test", password: "first-admin-password", password_confirm: "first-admin-password" } } });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toMatchObject({ completed_steps: ["admin"], admin_user_id: 1 });

    const save = async (step: string, payload: Record<string, unknown>) => test.app.inject({ method: "POST", url: "/api/setup/progress", headers: { cookie: setupCookie, "x-csrftoken": csrf }, payload: { step, payload } });
    expect((await save("store", { "application.store_name": "Installed Store", "application.store_description": "Disposable setup", "application.contact_email": "owner@example.test" })).statusCode).toBe(200);
    expect((await save("registration", { "registration.enabled": false, "registration.require_email_verification": true })).statusCode).toBe(200);
    expect((await save("security", { "session.lifetime_seconds": 3600, "publishing.enabled": true, "review.require_note_on_rejection": true, "security.notify_user_on_account_change": true })).statusCode).toBe(200);
    for (const step of ["smtp", "oidc", "saml", "mdns"] as const) expect((await save(step, { enabled: false })).statusCode).toBe(200);
    expect((await save("review", {})).statusCode).toBe(200);

    const complete = await test.app.inject({ method: "POST", url: "/api/setup/complete", headers: { cookie: setupCookie, "x-csrftoken": csrf }, payload: {} });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ state: "INSTALLATION_COMPLETE", redirect: "/auth/login" });
    const replay = await test.app.inject({ method: "POST", url: "/api/setup/complete", headers: { cookie: setupCookie, "x-csrftoken": csrf }, payload: {} });
    expect(replay.statusCode).toBe(401);
    const completed = await test.app.inject({ method: "GET", url: "/api/setup/status" });
    expect(completed.json()).toMatchObject({ state: "INSTALLATION_COMPLETE", setup_required: false });
    const authorizationReplay = await test.app.inject({ method: "POST", url: "/api/setup/authorize", payload: { bootstrap_token: BOOTSTRAP } });
    expect(authorizationReplay.statusCode).toBe(409);

    const database = new (await import("better-sqlite3")).default(path.join(test.root, "store.sqlite"), { readonly: true });
    expect(database.prepare("SELECT state FROM setup_state WHERE singleton_id = 1").get()).toEqual({ state: "INSTALLATION_COMPLETE" });
    expect(database.prepare("SELECT value_json FROM application_settings WHERE setting_key = 'application.store_name'").get()).toEqual({ value_json: '"Installed Store"' });
    database.close();
    await test.app.close();

    const restarted = buildApp({ config: loadConfig({
      NODE_ENV: "test",
      PRG32_BACKEND_DB: path.join(test.root, "store.sqlite"),
      PRG32_BACKEND_STORE_DATA: test.root,
      PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
      PRG32_BACKEND_CANONICAL_STORAGE_ROOT: test.root,
      PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: CANONICAL_READ_AUTHORIZATION,
      PRG32_BACKEND_CANONICAL_WORKFLOW_MODE: "disposable",
      PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION: CANONICAL_WRITE_AUTHORIZATION,
      PRG32_BACKEND_CANDIDATE_MODE: "two-service-disposable",
      PRG32_BACKEND_CANDIDATE_AUTHORIZATION: CANDIDATE_RUNTIME_AUTHORIZATION,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: path.join(test.root, "store.sqlite"),
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: test.root,
      PRG32_BACKEND_SESSION_SECRET: "m537-setup-session-secret-0123456789",
      PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
      PRG32_BACKEND_SESSION_SECURE: "false"
    }), logger: false });
    expect((await restarted.inject({ method: "GET", url: "/api/setup/status" })).json()).toMatchObject({ state: "INSTALLATION_COMPLETE", setup_required: false });
    await restarted.close();
  });

  it("prevents concurrent setup sessions and rejects cross-origin mutations", async () => {
    const test = fixture();
    const first = await test.app.inject({ method: "POST", url: "/api/setup/authorize", payload: { bootstrap_token: BOOTSTRAP } });
    const second = await test.app.inject({ method: "POST", url: "/api/setup/authorize", payload: { bootstrap_token: BOOTSTRAP } });
    expect(second.statusCode).toBe(409);
    const crossOrigin = await test.app.inject({ method: "POST", url: "/api/setup/authorize", headers: { origin: "https://evil.example" }, payload: { bootstrap_token: BOOTSTRAP } });
    expect(crossOrigin.statusCode).toBe(403);
    expect(cookie(first)).toContain("prg32_setup_session=");
    await test.app.close();
  });

  it("protects an existing populated canonical installation from setup replay", async () => {
    const test = fixture({ seedAdmin: true });
    const status = await test.app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.json()).toMatchObject({ state: "INSTALLATION_COMPLETE", setup_required: false });
    const authorize = await test.app.inject({ method: "POST", url: "/api/setup/authorize", payload: { bootstrap_token: BOOTSTRAP } });
    expect(authorize.statusCode).toBe(409);
    await test.app.close();
  });

  it("configures SMTP and generic OIDC/SAML providers without exposing secrets or arbitrary callbacks", async () => {
    const test = fixture();
    const authorized = await test.app.inject({ method: "POST", url: "/api/setup/authorize", payload: { bootstrap_token: BOOTSTRAP } });
    const setupCookie = cookie(authorized);
    const csrf = authorized.json<{ csrf_token: string }>().csrf_token;
    const save = (step: string, payload: Record<string, unknown>) => test.app.inject({ method: "POST", url: "/api/setup/progress", headers: { cookie: setupCookie, "x-csrftoken": csrf }, payload: { step, payload } });
    expect((await save("admin", { username: "integration-admin", email: "integration-admin@example.test", password: "integration-admin-password", password_confirm: "integration-admin-password" })).statusCode).toBe(200);
    expect((await save("smtp", { "smtp.enabled": true, "smtp.host": "mailpit", "smtp.port": 1025, "smtp.encryption": "none", "smtp.auth_enabled": false, "smtp.from_email": "store@example.test", "smtp.password": "never-return-this" })).statusCode).toBe(200);
    const oidc = await save("oidc", { enabled: true, provider_id: "generic-oidc", display_name: "Generic OIDC", issuer: "https://idp.example.test/oidc", client_id: "prg32-client", client_secret: "oidc-secret-never-returned" });
    expect(oidc.statusCode).toBe(200);
    const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" } });
    const saml = await save("saml", { enabled: true, provider_id: "generic-saml", display_name: "Generic SAML", idp_entity_id: "https://idp.example.test/saml", saml_entry_point: "https://idp.example.test/sso", saml_idp_certificate_pem: keys.publicKey });
    expect(saml.statusCode).toBe(200);
    const mdnsDenied = await save("mdns", { enabled: true });
    expect(mdnsDenied.statusCode).toBe(409);
    expect((await save("mdns", { enabled: false })).statusCode).toBe(200);
    const database = new (await import("better-sqlite3")).default(path.join(test.root, "store.sqlite"), { readonly: true });
    const provider = database.prepare("SELECT protocol, enabled, redirect_uri, acs_url FROM federation_providers ORDER BY provider_id").all() as Array<{ protocol: string; enabled: number; redirect_uri: string | null; acs_url: string | null }>;
    expect(provider).toHaveLength(2);
    expect(provider[0]).toMatchObject({ protocol: "oidc", enabled: 1, redirect_uri: "https://api.prg32.test/api/auth/oidc/generic-oidc/callback" });
    expect(provider[1]).toMatchObject({ protocol: "saml", enabled: 1, acs_url: "https://api.prg32.test/api/auth/saml/generic-saml/acs" });
    expect((database.prepare("SELECT value FROM store_settings WHERE key = 'smtp_password'").get() as { value: string }).value).not.toBe("never-return-this");
    database.close();
    const progress = await test.app.inject({ method: "GET", url: "/api/setup/progress", headers: { cookie: setupCookie } });
    expect(JSON.stringify(progress.json())).not.toContain("oidc-secret-never-returned");
    expect(JSON.stringify(progress.json())).not.toContain("never-return-this");
    await test.app.close();
  });
});
