import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import Database from "better-sqlite3";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { FederationIdentityService, ValidatedExternalIdentity } from "../src/federation/identity.js";
import { FederationProviderService } from "../src/federation/provider.js";

const roots: string[] = [];
const sessionSecret = "test-only-oidc-session-secret-that-is-long-enough";

interface PendingCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string;
}

interface MockOidcProvider {
  issuer: string;
  server: http.Server;
  subject: string;
  email: string;
  preferredUsername: string;
  invalidSignature: boolean;
  usePreviousSigningKey: boolean;
  rotateSigningKey(): Promise<void>;
  retirePreviousKey(): void;
  close(): Promise<void>;
}

async function createMockProvider(): Promise<MockOidcProvider> {
  let signingKey = await generateKeyPair("RS256");
  let publicJwk = await exportJWK(signingKey.publicKey);
  let previousKey: typeof signingKey | undefined;
  let previousJwk: Awaited<ReturnType<typeof exportJWK>> | undefined;
  let previousKid: string | undefined;
  let signingKid = "test-key";
  const pending = new Map<string, PendingCode>();
  const provider = { subject: "external-user", email: "linked@example.test", preferredUsername: "linked-user", invalidSignature: false, usePreviousSigningKey: false } as MockOidcProvider;
  // The handler is deliberately detached from the HTTP callback so the test
  // does not turn an asynchronous provider failure into an unhandled rejection.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = http.createServer(async (request, response) => {
    const base = provider.issuer;
    const url = new URL(request.url ?? "/", base);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const encoded = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), ...headers });
      response.end(encoded);
    };
    if (url.pathname === "/.well-known/openid-configuration" && request.method === "GET") {
      send(200, {
        issuer: provider.issuer,
        authorization_endpoint: provider.issuer + "authorize",
        token_endpoint: provider.issuer + "token",
        jwks_uri: provider.issuer + "jwks",
        id_token_signing_alg_values_supported: ["RS256"]
      });
      return;
    }
    if (url.pathname === "/jwks" && request.method === "GET") {
      const keys = [{ ...publicJwk, kid: signingKid, alg: "RS256", use: "sig" }];
      if (previousJwk && previousKid) keys.push({ ...previousJwk, kid: previousKid, alg: "RS256", use: "sig" });
      send(200, { keys });
      return;
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const clientId = url.searchParams.get("client_id");
      const state = url.searchParams.get("state");
      const codeChallenge = url.searchParams.get("code_challenge");
      const nonce = url.searchParams.get("nonce");
      if (!redirectUri || !clientId || !state || !codeChallenge || !nonce) {
        send(400, { error: "invalid_request" });
        return;
      }
      const code = crypto.randomBytes(24).toString("base64url");
      pending.set(code, { clientId, redirectUri, codeChallenge, nonce });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const code = body.get("code");
      const record = code ? pending.get(code) : undefined;
      const verifier = body.get("code_verifier") ?? "";
      const challenge = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
      if (!record || body.get("client_id") !== record.clientId || body.get("redirect_uri") !== record.redirectUri || challenge !== record.codeChallenge) {
        send(400, { error: "invalid_grant" });
        return;
      }
      pending.delete(code as string);
      const tokenKey = provider.invalidSignature
        ? (await generateKeyPair("RS256")).privateKey
        : provider.usePreviousSigningKey && previousKey
          ? previousKey.privateKey
          : signingKey.privateKey;
      const idToken = await new SignJWT({ sub: provider.subject, email: provider.email, preferred_username: provider.preferredUsername, name: "Linked User", nonce: record.nonce })
        .setProtectedHeader({ alg: "RS256", kid: provider.invalidSignature ? "wrong-key" : provider.usePreviousSigningKey && previousKid ? previousKid : signingKid })
        .setIssuer(provider.issuer)
        .setAudience(record.clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(tokenKey);
      send(200, { access_token: "access-token-not-persisted", token_type: "Bearer", expires_in: 300, id_token: idToken });
      return;
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock provider did not bind");
  provider.issuer = `http://127.0.0.1:${address.port}/`;
  provider.server = server;
  provider.rotateSigningKey = async () => {
    previousKey = signingKey;
    previousJwk = publicJwk;
    previousKid = signingKid;
    signingKey = await generateKeyPair("RS256");
    publicJwk = await exportJWK(signingKey.publicKey);
    signingKid = "rotated-key";
  };
  provider.retirePreviousKey = () => {
    previousJwk = undefined;
  };
  provider.close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return provider;
}

function createDatabase(root: string): string {
  const databasePath = path.join(root, "auth.sqlite");
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO users(username, email, password_hash, role) VALUES ('linked-user', 'linked@example.test', 'legacy-password-hash', 'user');
  `);
  database.close();
  return databasePath;
}

function createApp(databasePath: string, autoProvision = false) {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-oidc-shadow-"));
  roots.push(shadowRoot);
  const shadowPath = path.join(shadowRoot, "shadow.sqlite");
  fs.closeSync(fs.openSync(shadowPath, "a"));
  return buildApp({
    config: loadConfig({
      PRG32_BACKEND_DB: shadowPath,
      PRG32_BACKEND_STORE_DATA: path.dirname(databasePath),
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: path.dirname(databasePath),
      PRG32_BACKEND_SESSION_SECRET: sessionSecret,
      PRG32_BACKEND_SESSION_SECURE: "false",
      PRG32_BACKEND_FEDERATION_AUTO_PROVISION: autoProvision ? "true" : "false",
      PRG32_BACKEND_OIDC_PUBLIC_ORIGIN: "http://127.0.0.1:5090"
    }),
    logger: false
  });
}

function responseHeader(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function cookie(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const values = response.headers["set-cookie"];
  const all = Array.isArray(values) ? values : values ? [values] : [];
  return all.find((item) => item.startsWith(name + "="))?.split(";", 1)[0] ?? "";
}

async function fixture(autoProvision = false): Promise<{ app: ReturnType<typeof buildApp>; databasePath: string; provider: MockOidcProvider }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-oidc-"));
  roots.push(root);
  const provider = await createMockProvider();
  const databasePath = createDatabase(root);
  const app = createApp(databasePath, autoProvision);
  const database = new Database(databasePath);
  const providers = new FederationProviderService(database);
  const config = providers.create({
    providerId: "school",
    protocol: "oidc",
    displayName: "Disposable School IdP",
    issuer: provider.issuer,
    clientId: "prg32-client",
    clientAuthMethod: "none",
    redirectUri: "http://127.0.0.1:5090/api/auth/oidc/school/callback",
    scopes: ["openid", "email", "profile"]
  }, undefined, true);
  providers.setEnabled(config.providerId, true);
  const identities = new FederationIdentityService(database, providers);
  identities.link(ValidatedExternalIdentity.fromProtocolAdapter({
    protocol: "oidc",
    providerId: "school",
    issuer: provider.issuer,
    subject: provider.subject,
    authenticatedAt: new Date().toISOString()
  }), 1, { actorUserId: 1, actorRole: "admin", reauthenticatedAt: Date.now(), requestId: "fixture" });
  database.close();
  return { app, databasePath, provider };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OIDC protocol implementation", () => {
  it("executes discovery, PKCE, nonce validation, identity resolution, and session rotation", async () => {
    const test = await fixture();
    const login = await test.app.inject({ method: "GET", url: "/api/auth/oidc/school/login?return_to=/catalog" });
    expect(login.statusCode).toBe(302);
    const authorization = await fetch(responseHeader(login, "location"), { redirect: "manual" });
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get("location") ?? "");
    const correlation = cookie(login, "prg32_oidc_correlation");
    expect(correlation).toMatch(/^prg32_oidc_correlation=/);
    expect(new URL(responseHeader(login, "location")).searchParams.get("code_challenge")).toBeTruthy();
    const completed = await test.app.inject({ method: "GET", url: callback.pathname + callback.search, headers: { cookie: correlation } });
    expect(completed.statusCode).toBe(302);
    expect(responseHeader(completed, "location")).toBe("/catalog");
    const session = cookie(completed, "prg32_ts_session");
    expect(session).toMatch(/^prg32_ts_session=/);
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { cookie: session } })).statusCode).toBe(200);

    const replay = await test.app.inject({ method: "GET", url: callback.pathname + callback.search, headers: { cookie: correlation } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ ok: false, code: "oidc_replay_rejected" });

    const database = new Database(test.databasePath, { readonly: true });
    const transaction = database.prepare("SELECT nonce_ciphertext, pkce_verifier_ciphertext FROM federation_transactions LIMIT 1").get() as { nonce_ciphertext: string; pkce_verifier_ciphertext: string };
    expect(transaction.nonce_ciphertext).toMatch(/^prg32txn:v1:/);
    expect(transaction.pkce_verifier_ciphertext).toMatch(/^prg32txn:v1:/);
    expect(database.prepare("SELECT COUNT(*) AS count FROM federation_provider_secrets").get()).toEqual({ count: 0 });
    database.close();
    await test.app.close();
    await test.provider.close();
  });

  it("accepts an OIDC signing-key overlap and rejects a retired or unknown key", async () => {
    const test = await fixture();
    const completeLogin = async () => {
      const login = await test.app.inject({ method: "GET", url: "/api/auth/oidc/school/login" });
      const authorization = await fetch(responseHeader(login, "location"), { redirect: "manual" });
      const callback = new URL(authorization.headers.get("location") ?? "");
      return test.app.inject({ method: "GET", url: callback.pathname + callback.search, headers: { cookie: cookie(login, "prg32_oidc_correlation") } });
    };

    expect((await completeLogin()).statusCode).toBe(302);
    await test.provider.rotateSigningKey();
    test.provider.usePreviousSigningKey = true;
    expect((await completeLogin()).statusCode).toBe(302);

    test.provider.retirePreviousKey();
    const retired = await completeLogin();
    expect(retired.statusCode).toBe(401);
    expect(retired.json()).toMatchObject({ ok: false, code: "oidc_callback_invalid" });

    test.provider.usePreviousSigningKey = false;
    expect((await completeLogin()).statusCode).toBe(302);
    await test.app.close();
    await test.provider.close();
  });

  it("rejects invalid signatures, unknown identities, disabled accounts, and browser-binding failures predictably", async () => {
    const test = await fixture();
    test.provider.invalidSignature = true;
    const invalidLogin = await test.app.inject({ method: "GET", url: "/api/auth/oidc/school/login" });
    const invalidAuthorization = await fetch(responseHeader(invalidLogin, "location"), { redirect: "manual" });
    const invalidCallback = new URL(invalidAuthorization.headers.get("location") ?? "");
    const invalid = await test.app.inject({ method: "GET", url: invalidCallback.pathname + invalidCallback.search, headers: { cookie: cookie(invalidLogin, "prg32_oidc_correlation") } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({ ok: false, code: "oidc_callback_invalid" });

    test.provider.invalidSignature = false;
    test.provider.subject = "not-linked";
    const unknownLogin = await test.app.inject({ method: "GET", url: "/api/auth/oidc/school/login" });
    const unknownAuthorization = await fetch(responseHeader(unknownLogin, "location"), { redirect: "manual" });
    const unknownCallback = new URL(unknownAuthorization.headers.get("location") ?? "");
    const unknown = await test.app.inject({ method: "GET", url: unknownCallback.pathname + unknownCallback.search, headers: { cookie: cookie(unknownLogin, "prg32_oidc_correlation") } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ ok: false, code: "oidc_identity_link_required" });

    test.provider.subject = "external-user";
    const disabledDatabase = new Database(test.databasePath);
    disabledDatabase.prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = 1").run();
    disabledDatabase.close();
    const disabledLogin = await test.app.inject({ method: "GET", url: "/api/auth/oidc/school/login" });
    const disabledAuthorization = await fetch(responseHeader(disabledLogin, "location"), { redirect: "manual" });
    const disabledCallback = new URL(disabledAuthorization.headers.get("location") ?? "");
    const disabled = await test.app.inject({ method: "GET", url: disabledCallback.pathname + disabledCallback.search, headers: { cookie: cookie(disabledLogin, "prg32_oidc_correlation") } });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toMatchObject({ ok: false, code: "oidc_account_disabled" });

    const bindingLogin = await test.app.inject({ method: "GET", url: "/api/auth/oidc/school/login" });
    const bindingAuthorization = await fetch(responseHeader(bindingLogin, "location"), { redirect: "manual" });
    const bindingCallback = new URL(bindingAuthorization.headers.get("location") ?? "");
    const wrongBinding = await test.app.inject({ method: "GET", url: bindingCallback.pathname + bindingCallback.search, headers: { cookie: "prg32_oidc_correlation=invalid" } });
    expect(wrongBinding.statusCode).toBe(401);
    expect(wrongBinding.json()).toMatchObject({ ok: false, code: "oidc_browser_binding_failed" });

    await test.app.close();
    await test.provider.close();
  });

  it("provisions a new federated identity only with an explicit disposable opt-in", async () => {
    const test = await fixture(true);
    test.provider.subject = "new-external-user";
    test.provider.email = "new-user@example.test";
    test.provider.preferredUsername = "new-user";
    const login = await test.app.inject({ method: "GET", url: "/api/auth/oidc/school/login" });
    const authorization = await fetch(responseHeader(login, "location"), { redirect: "manual" });
    const callback = new URL(authorization.headers.get("location") ?? "");
    const completed = await test.app.inject({ method: "GET", url: callback.pathname + callback.search, headers: { cookie: cookie(login, "prg32_oidc_correlation") } });
    expect(completed.statusCode).toBe(302);
    const database = new Database(test.databasePath, { readonly: true });
    expect(database.prepare("SELECT username, email, password_hash, role FROM users WHERE email = ?").get("new-user@example.test"))
      .toMatchObject({ username: "new-user", email: "new-user@example.test", password_hash: null, role: "user" });
    expect(database.prepare("SELECT subject, provider_id FROM user_external_identities WHERE subject = ?").get("new-external-user"))
      .toEqual({ subject: "new-external-user", provider_id: "school" });
    database.close();
    await test.app.close();
    await test.provider.close();
  });

  it("refuses auto-provisioning when the email already belongs to a local account", async () => {
    const test = await fixture(true);
    test.provider.subject = "different-subject";
    const login = await test.app.inject({ method: "GET", url: "/api/auth/oidc/school/login" });
    const authorization = await fetch(responseHeader(login, "location"), { redirect: "manual" });
    const callback = new URL(authorization.headers.get("location") ?? "");
    const result = await test.app.inject({ method: "GET", url: callback.pathname + callback.search, headers: { cookie: cookie(login, "prg32_oidc_correlation") } });
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ ok: false, code: "oidc_identity_conflict" });
    await test.app.close();
    await test.provider.close();
  });

  it("fails closed when a confidential provider has no encrypted client secret", async () => {
    const test = await fixture();
    const database = new Database(test.databasePath);
    const providers = new FederationProviderService(database);
    providers.update("school", { clientAuthMethod: "client_secret_basic" }, undefined, true);
    database.close();
    const login = await test.app.inject({ method: "GET", url: "/api/auth/oidc/school/login" });
    expect(login.statusCode).toBe(503);
    expect(login.json()).toMatchObject({ ok: false, code: "oidc_client_secret_missing" });
    await test.app.close();
    await test.provider.close();
  });
});
