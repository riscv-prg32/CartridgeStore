import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import Database from "better-sqlite3";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { SignedXml } from "xml-crypto";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { FederationIdentityService, ValidatedExternalIdentity } from "../src/federation/identity.js";
import { FederationProviderService } from "../src/federation/provider.js";
import { hashApiToken } from "../src/auth/tokens.js";

const roots: string[] = [];
const sessionSecret = "test-only-edge-federation-session-secret-long-enough";
const samlPersistentNameId = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

interface HttpResult {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface CertificatePair {
  readonly key: string;
  readonly cert: string;
}

interface OidcProvider {
  readonly issuer: string;
  readonly close: () => Promise<void>;
}

interface SamlProvider {
  readonly issuer: string;
  readonly entryPoint: string;
  readonly privateKey: string;
  readonly publicKey: string;
  readonly close: () => Promise<void>;
}

interface EdgeFixture {
  readonly origin: string;
  readonly app: ReturnType<typeof buildApp>;
  readonly databasePath: string;
  readonly oidc: OidcProvider;
  readonly saml: SamlProvider;
  readonly close: () => Promise<void>;
}

function listen(server: net.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("server did not bind to a TCP port"));
      resolve(address.port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function disposableCertificate(root: string): CertificatePair {
  const keyPath = path.join(root, "edge.key");
  const certPath = path.join(root, "edge.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-subj", "/CN=localhost", "-days", "1"
  ], { stdio: "ignore" });
  return { key: fs.readFileSync(keyPath, "utf8"), cert: fs.readFileSync(certPath, "utf8") };
}

function proxyHeaders(request: http.IncomingMessage, upstreamPort: number, publicHost: string, edgePort: number): Record<string, string | string[]> {
  return {
    ...request.headers,
    host: `127.0.0.1:${upstreamPort}`,
    "x-forwarded-proto": "https",
    "x-forwarded-host": publicHost,
    "x-forwarded-port": String(edgePort),
    "x-forwarded-for": "127.0.0.1"
  };
}

async function startEdge(upstreamPort: number, edgePort: number, pair: CertificatePair, publicHost: string): Promise<https.Server> {
  const server = https.createServer({ key: pair.key, cert: pair.cert }, (request, response) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request, upstreamPort, publicHost, edgePort)
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, code: "edge_upstream_unavailable" }));
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, clientSocket, head) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request, upstreamPort, publicHost, edgePort)
    });
    upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const responseLines = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}`];
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        responseLines.push(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`);
      }
      responseLines.push("", "");
      clientSocket.write(responseLines.join("\r\n"));
      if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    upstream.once("response", (response) => {
      response.resume();
      clientSocket.end();
    });
    upstream.once("error", () => clientSocket.destroy());
    upstream.end();
  });

  await listen(server, edgePort);
  return server;
}

function requestHttps(target: string, options: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } = {}): Promise<HttpResult> {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (body) headers["content-length"] = String(Buffer.byteLength(body));
    const request = https.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers,
      rejectUnauthorized: false
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function cookie(response: HttpResult, name: string): string {
  const values = response.headers["set-cookie"] ?? [];
  const all = Array.isArray(values) ? values : [values];
  return all.find((value) => value.startsWith(name + "="))?.split(";", 1)[0] ?? "";
}

function setCookieHeader(response: HttpResult, name: string): string {
  const values = response.headers["set-cookie"] ?? [];
  const all = Array.isArray(values) ? values : [values];
  return all.find((value) => value.startsWith(name + "=")) ?? "";
}

function createAuthDatabase(root: string, token: string): string {
  const databasePath = path.join(root, "auth.sqlite");
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO users(username, email, password_hash, role) VALUES ('edge-user', 'edge@example.test', 'legacy-password-hash', 'player');
  `);
  database.prepare("INSERT INTO api_tokens(user_id, token_hash, label, created_at) VALUES (1, ?, 'edge websocket', datetime('now'))").run(hashApiToken(token));
  database.close();
  return databasePath;
}

async function createOidcProvider(): Promise<OidcProvider> {
  const signingKey = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(signingKey.publicKey);
  const pending = new Map<string, { readonly clientId: string; readonly redirectUri: string; readonly challenge: string; readonly nonce: string }>();
  const provider: { issuer: string; subject: string; email: string; username: string } = { issuer: "", subject: "oidc-edge-subject", email: "edge@example.test", username: "edge-user" };
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://oidc.invalid");
    const send = (status: number, body: unknown) => {
      const encoded = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) });
      response.end(encoded);
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      send(200, { issuer: provider.issuer, authorization_endpoint: provider.issuer + "authorize", token_endpoint: provider.issuer + "token", jwks_uri: provider.issuer + "jwks", id_token_signing_alg_values_supported: ["RS256"] });
      return;
    }
    if (url.pathname === "/jwks") {
      send(200, { keys: [{ ...publicJwk, kid: "edge-key", alg: "RS256", use: "sig" }] });
      return;
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const clientId = url.searchParams.get("client_id");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const nonce = url.searchParams.get("nonce");
      if (!redirectUri || !clientId || !state || !challenge || !nonce) return send(400, { error: "invalid_request" });
      const code = crypto.randomBytes(24).toString("base64url");
      pending.set(code, { clientId, redirectUri, challenge, nonce });
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
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const code = form.get("code");
      const record = code ? pending.get(code) : undefined;
      const verifier = form.get("code_verifier") ?? "";
      const challenge = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
      if (!record || form.get("client_id") !== record.clientId || form.get("redirect_uri") !== record.redirectUri || challenge !== record.challenge) return send(400, { error: "invalid_grant" });
      pending.delete(code as string);
      const idToken = await new SignJWT({ sub: provider.subject, email: provider.email, preferred_username: provider.username, name: "Edge User", nonce: record.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "edge-key" })
        .setIssuer(provider.issuer)
        .setAudience(record.clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(signingKey.privateKey);
      send(200, { access_token: "disposable", token_type: "Bearer", expires_in: 300, id_token: idToken });
      return;
    }
    send(404, { error: "not_found" });
  });
  const port = await listen(server);
  const issuer = `http://127.0.0.1:${port}/`;
  provider.issuer = issuer;
  return { issuer, close: () => closeServer(server) };
}

function signXml(xml: string, privateKey: string, xpath: string, location: string): string {
  const signature = new SignedXml({
    privateKey,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
  });
  signature.addReference({
    xpath,
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256"
  });
  signature.computeSignature(xml, { location: { reference: location, action: "append" } });
  return signature.getSignedXml();
}

function samlResponse(requestId: string, acsUrl: string, issuer: string, privateKey: string, audience: string): string {
  const now = new Date();
  const issueInstant = now.toISOString();
  const notOnOrAfter = new Date(now.getTime() + 5 * 60_000).toISOString();
  const assertionId = "_" + crypto.randomBytes(24).toString("base64url");
  const responseId = "_" + crypto.randomBytes(24).toString("base64url");
  const bare = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${acsUrl}" InResponseTo="${requestId}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="${samlPersistentNameId}">saml-edge-subject</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${acsUrl}" NotOnOrAfter="${notOnOrAfter}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${issueInstant}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="_edge-session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
  const assertionSigned = signXml(bare, privateKey, "//*[local-name(.)='Assertion']", "//*[local-name(.)='Assertion']");
  return signXml(assertionSigned, privateKey, "//*[local-name(.)='Response']", "//*[local-name(.)='Response']");
}

async function createSamlProvider(pair: CertificatePair, edgeOrigin: string): Promise<SamlProvider> {
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
  const server = https.createServer({ key: pair.key, cert: pair.cert }, (request, response) => {
    const url = new URL(request.url ?? "/", "https://idp.invalid");
    const samlRequest = url.searchParams.get("SAMLRequest");
    const relayState = url.searchParams.get("RelayState") ?? "";
    if (url.pathname !== "/sso" || !samlRequest) {
      response.writeHead(404);
      response.end();
      return;
    }
    const inflated = zlib.inflateRawSync(Buffer.from(samlRequest, "base64")).toString("utf8");
    const requestId = inflated.match(/\bID="([^"]+)"/)?.[1];
    if (!requestId) {
      response.writeHead(400);
      response.end();
      return;
    }
    const payload = Buffer.from(samlResponse(requestId, `${edgeOrigin}/api/auth/saml/school-saml/acs`, issuer, keys.privateKey, "https://edge.example.test/sp"), "utf8").toString("base64");
    const html = `<html><body><form method="post" action="${edgeOrigin}/api/auth/saml/school-saml/acs"><input type="hidden" name="SAMLResponse" value="${payload}"><input type="hidden" name="RelayState" value="${relayState}"></form></body></html>`;
    response.writeHead(200, { "content-type": "text/html", "content-length": String(Buffer.byteLength(html)) });
    response.end(html);
  });
  const port = await listen(server);
  const issuer = `https://127.0.0.1:${port}/saml`;
  const entryPoint = `https://127.0.0.1:${port}/sso`;
  return { issuer, entryPoint, privateKey: keys.privateKey, publicKey: keys.publicKey, close: () => closeServer(server) };
}

async function fixture(): Promise<EdgeFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-edge-federation-"));
  roots.push(root);
  const pair = disposableCertificate(root);
  const oidc = await createOidcProvider();
  const reservation = net.createServer();
  const edgePort = await listen(reservation);
  await closeServer(reservation);
  const origin = `https://127.0.0.1:${edgePort}`;
  const token = "edge-websocket-token";
  const databasePath = createAuthDatabase(root, token);
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-edge-shadow-"));
  roots.push(shadowRoot);
  const shadowPath = path.join(shadowRoot, "shadow.sqlite");
  fs.closeSync(fs.openSync(shadowPath, "a"));
  const app = buildApp({
    config: loadConfig({
      PRG32_BACKEND_DB: shadowPath,
      PRG32_BACKEND_STORE_DATA: root,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: databasePath,
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: root,
      PRG32_BACKEND_SESSION_SECRET: sessionSecret,
      PRG32_BACKEND_SESSION_SECURE: "true",
      PRG32_BACKEND_SESSION_SAMESITE: "lax",
      PRG32_BACKEND_OIDC_PUBLIC_ORIGIN: origin,
      PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN: origin,
      PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN: origin,
      PRG32_BACKEND_CORS_ORIGINS: origin
    }),
    logger: false
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("Fastify did not bind");
  const edge = await startEdge(address.port, edgePort, pair, new URL(origin).host);
  const saml = await createSamlProvider(pair, origin);
  const database = new Database(databasePath);
  const providers = new FederationProviderService(database);
  const oidcProvider = providers.create({
    providerId: "school",
    protocol: "oidc",
    displayName: "Synthetic OIDC",
    issuer: oidc.issuer,
    clientId: "edge-client",
    clientAuthMethod: "none",
    redirectUri: `${origin}/api/auth/oidc/school/callback`,
    scopes: ["openid", "email", "profile"]
  }, undefined, true);
  providers.setEnabled(oidcProvider.providerId, true);
  const samlProvider = providers.create({
    providerId: "school-saml",
    protocol: "saml",
    displayName: "Synthetic SAML",
    issuer: saml.issuer,
    idpEntityId: saml.issuer,
    spEntityId: "https://edge.example.test/sp",
    acsUrl: `${origin}/api/auth/saml/school-saml/acs`,
    samlEntryPoint: saml.entryPoint,
    samlNameIdFormat: samlPersistentNameId,
    samlIdpCertificatePem: saml.publicKey,
    samlWantAssertionsSigned: true,
    samlWantAuthnResponseSigned: true
  }, undefined, true);
  providers.setEnabled(samlProvider.providerId, true);
  const identities = new FederationIdentityService(database, providers);
  const identityOptions = { actorUserId: 1, actorRole: "admin" as const, reauthenticatedAt: Date.now(), requestId: "edge-fixture" };
  identities.link(ValidatedExternalIdentity.fromProtocolAdapter({ protocol: "oidc", providerId: "school", issuer: oidc.issuer, subject: "oidc-edge-subject", authenticatedAt: new Date().toISOString() }), 1, identityOptions);
  identities.link(ValidatedExternalIdentity.fromProtocolAdapter({ protocol: "saml", providerId: "school-saml", issuer: saml.issuer, subject: "saml-edge-subject", authenticatedAt: new Date().toISOString() }), 1, identityOptions);
  database.close();
  return {
    origin,
    app,
    databasePath,
    oidc,
    saml,
    close: async () => {
      await app.close();
      await closeServer(edge);
      await oidc.close();
      await saml.close();
    }
  };
}

function field(html: string, name: string): string {
  const match = html.match(new RegExp(`<input[^>]+name=["']${name}["'][^>]+value=["']([^"']+)["']`));
  if (!match?.[1]) throw new Error(`SAML field ${name} missing`);
  return match[1];
}

function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (payload: WebSocket.RawData) => {
      socket.off("error", onError);
      const text = typeof payload === "string"
        ? payload
        : Array.isArray(payload)
          ? Buffer.concat(payload).toString("utf8")
          : payload instanceof ArrayBuffer
            ? Buffer.from(payload).toString("utf8")
            : payload.toString("utf8");
      resolve(JSON.parse(text) as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("isolated edge and federation integration", () => {
  it("terminates TLS, overwrites forwarded headers, and emits public discovery URLs", async () => {
    const test = await fixture();
    const discovery = await requestHttps(`${test.origin}/.well-known/prg32-store.json`, {
      headers: { host: "evil.example.test", "x-forwarded-host": "evil.example.test", "x-forwarded-proto": "http" }
    });
    expect(discovery.status).toBe(200);
    const body = JSON.parse(discovery.body) as { api: string; web: string; services: { multiplayer: string } };
    expect(body.api).toBe(`${test.origin}/api`);
    expect(body.web).toBe(`${test.origin}/`);
    expect(body.services.multiplayer).toBe(`${test.origin.replace("https://", "wss://")}/api/multiplayer`);
    expect(discovery.body).not.toContain("evil.example.test");

    const multiplayer = await requestHttps(`${test.origin}/api/multiplayer`, { headers: { host: "evil.example.test", "x-forwarded-host": "evil.example.test" } });
    expect(multiplayer.status).toBe(200);
    const multiplayerBody = JSON.parse(multiplayer.body) as { websocket?: unknown };
    expect(multiplayerBody.websocket).toBe(`${test.origin.replace("https://", "wss://")}/api/multiplayer`);
    await test.close();
  });

  it("completes a synthetic OIDC callback through the TLS edge and rotates the session", async () => {
    const test = await fixture();
    const login = await requestHttps(`${test.origin}/api/auth/oidc/school/login?return_to=/dashboard/account`, { headers: { host: "evil.example.test" } });
    expect(login.status).toBe(302);
    const correlation = cookie(login, "prg32_oidc_correlation");
    const authorization = await fetch(login.headers.location as string, { redirect: "manual" });
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get("location") as string);
    const completed = await requestHttps(callback.toString(), { headers: { cookie: correlation, host: "evil.example.test" } });
    expect(completed.status).toBe(302);
    expect(completed.headers.location).toBe(`${test.origin}/dashboard/account`);
    const session = cookie(completed, "prg32_ts_session");
    expect(setCookieHeader(completed, "prg32_ts_session")).toContain("Secure");
    expect(setCookieHeader(completed, "prg32_ts_session")).toContain("HttpOnly");
    const me = await requestHttps(`${test.origin}/auth/me`, { headers: { cookie: session } });
    expect(me.status).toBe(200);
    const csrf = await requestHttps(`${test.origin}/auth/csrf`, { headers: { cookie: session } });
    const csrfToken = (JSON.parse(csrf.body) as { csrf_token: string }).csrf_token;
    const logout = await requestHttps(`${test.origin}/auth/logout`, { method: "POST", headers: { cookie: session, "x-csrftoken": csrfToken } });
    expect(logout.status).toBe(200);
    expect((await requestHttps(`${test.origin}/auth/me`, { headers: { cookie: session } })).status).toBe(401);
    expect((await requestHttps(`${test.origin}/auth/me`, { headers: { cookie: "session=invalid-test-cookie" } })).status).toBe(401);
    await test.close();
  });

  it("completes a synthetic signed SAML POST callback through the TLS edge", async () => {
    const test = await fixture();
    const login = await requestHttps(`${test.origin}/api/auth/saml/school-saml/login?return_to=/workspace`);
    expect(login.status).toBe(302);
    const correlation = cookie(login, "prg32_saml_correlation");
    const idp = await requestHttps(login.headers.location as string);
    expect(idp.status).toBe(200);
    const form = new URLSearchParams({ SAMLResponse: field(idp.body, "SAMLResponse"), RelayState: field(idp.body, "RelayState") });
    const completed = await requestHttps(`${test.origin}/api/auth/saml/school-saml/acs`, {
      method: "POST",
      headers: { cookie: correlation, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    expect(completed.status).toBe(302);
    expect(completed.headers.location).toBe(`${test.origin}/workspace`);
    expect((await requestHttps(`${test.origin}/auth/me`, { headers: { cookie: cookie(completed, "prg32_ts_session") } })).status).toBe(200);
    await test.close();
  });

  it("routes authenticated WebSocket upgrade over TLS and rejects an invalid token", async () => {
    const test = await fixture();
    const socket = new WebSocket(`${test.origin.replace("https://", "wss://")}/api/multiplayer`, {
      rejectUnauthorized: false,
      headers: { Authorization: "Bearer edge-websocket-token" }
    });
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "join", signature: "edge-room", player_id: 1 }));
    await expect(waitForMessage(socket)).resolves.toMatchObject({ type: "welcome", player_id: 1 });
    socket.close();

    const invalid = new WebSocket(`${test.origin.replace("https://", "wss://")}/api/multiplayer`, { rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => { invalid.once("open", () => resolve()); invalid.once("error", reject); });
    invalid.send(JSON.stringify({ type: "join", signature: "edge-room", player_id: 2 }));
    await expect(waitForMessage(invalid)).resolves.toMatchObject({ type: "error", error: "player role required" });
    invalid.close();
    await test.close();
  });
});
