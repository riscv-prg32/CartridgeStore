import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import Database from "better-sqlite3";
import { SignedXml } from "xml-crypto";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { FederationIdentityService, ValidatedExternalIdentity } from "../src/federation/identity.js";
import { FederationProviderService } from "../src/federation/provider.js";

const roots: string[] = [];
const sessionSecret = "test-only-saml-session-secret-that-is-long-enough";
const persistentNameId = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

function createDatabase(root: string): string {
  const databasePath = path.join(root, "auth.sqlite");
  const database = new Database(databasePath);
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT); CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT); CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE); CREATE TABLE user_groups (user_id INTEGER NOT NULL, group_id INTEGER NOT NULL, PRIMARY KEY(user_id, group_id)); CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT); CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO users(username,email,password_hash,role) VALUES ('saml-user','saml@example.test','legacy-password-hash','user');");
  database.close();
  return databasePath;
}

function cookie(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const values = response.headers["set-cookie"];
  const all = Array.isArray(values) ? values : values ? [values] : [];
  return all.find((item) => item.startsWith(name + "="))?.split(";", 1)[0] ?? "";
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

interface ResponseOverrides {
  readonly issuer?: string;
  readonly audience?: string;
  readonly destination?: string;
  readonly recipient?: string;
  readonly notOnOrAfter?: string;
  readonly email?: string;
}

function signedResponse(requestId: string, acsUrl: string, idpIssuer: string, privateKey: string, subject: string, overrides: ResponseOverrides = {}): string {
  const now = new Date();
  const issueInstant = now.toISOString();
  const notOnOrAfter = overrides.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000).toISOString();
  const responseIssuer = overrides.issuer ?? idpIssuer;
  const destination = overrides.destination ?? acsUrl;
  const recipient = overrides.recipient ?? acsUrl;
  const audience = overrides.audience ?? "https://store.example.test/sp";
  const assertionId = "_" + crypto.randomBytes(24).toString("base64url");
  const responseId = "_" + crypto.randomBytes(24).toString("base64url");
  const attributes = overrides.email ? `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${overrides.email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` : "";
  const bare = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${destination}" InResponseTo="${requestId}"><saml:Issuer>${responseIssuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}"><saml:Issuer>${responseIssuer}</saml:Issuer><saml:Subject><saml:NameID Format="${persistentNameId}">${subject}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${recipient}" NotOnOrAfter="${notOnOrAfter}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${issueInstant}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>${attributes}<saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="_session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
  const assertionSigned = signXml(bare, privateKey, "//*[local-name(.)='Assertion']", "//*[local-name(.)='Assertion']");
  return signXml(assertionSigned, privateKey, "//*[local-name(.)='Response']", "//*[local-name(.)='Response']");
}

function decodeRedirectRequest(location: string): { requestId: string; relayState: string } {
  const url = new URL(location);
  const encoded = url.searchParams.get("SAMLRequest");
  const relayState = url.searchParams.get("RelayState");
  if (!encoded || !relayState) throw new Error("SAML redirect request is incomplete");
  const inflated = zlib.inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8");
  const requestId = inflated.match(/\bID="([^"]+)"/)?.[1];
  if (!requestId) throw new Error("SAML request ID is missing");
  return { requestId, relayState };
}

function fixture(autoProvision = false): { app: ReturnType<typeof buildApp>; databasePath: string; idpIssuer: string; privateKey: string; publicKey: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-saml-"));
  roots.push(root);
  const databasePath = createDatabase(root);
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-saml-shadow-"));
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
      PRG32_BACKEND_SESSION_SECURE: "false",
      PRG32_BACKEND_FEDERATION_AUTO_PROVISION: autoProvision ? "true" : "false",
      PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN: "http://127.0.0.1:5090"
    }),
    logger: false
  });
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
  const idpIssuer = "https://idp.example.test/saml";
  const database = new Database(databasePath);
  const providers = new FederationProviderService(database);
  providers.create({
    providerId: "school-saml",
    protocol: "saml",
    displayName: "Disposable SAML IdP",
    issuer: idpIssuer,
    idpEntityId: idpIssuer,
    spEntityId: "https://store.example.test/sp",
    acsUrl: "http://127.0.0.1:5090/api/auth/saml/school-saml/acs",
    samlEntryPoint: "https://idp.example.test/sso",
    samlNameIdFormat: persistentNameId,
    samlIdpCertificatePem: keys.publicKey,
    samlWantAssertionsSigned: true,
    samlWantAuthnResponseSigned: true
  }, undefined, true);
  providers.setEnabled("school-saml", true);
  const identities = new FederationIdentityService(database, providers);
  identities.link(ValidatedExternalIdentity.fromProtocolAdapter({ protocol: "saml", providerId: "school-saml", issuer: idpIssuer, subject: "saml-subject", authenticatedAt: new Date().toISOString() }), 1, { actorUserId: 1, actorRole: "admin", reauthenticatedAt: Date.now(), requestId: "fixture" });
  database.close();
  return { app, databasePath, idpIssuer, privateKey: keys.privateKey, publicKey: keys.publicKey };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SAML service provider", () => {
  it("generates SP metadata and completes signed SP-initiated HTTP-Redirect/POST SSO", async () => {
    const test = fixture();
    const metadata = await test.app.inject({ method: "GET", url: "/api/auth/saml/school-saml/metadata" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.body).toContain("https://store.example.test/sp");
    expect(metadata.body).toContain("/api/auth/saml/school-saml/acs");

    const login = await test.app.inject({ method: "GET", url: "/api/auth/saml/school-saml/login?return_to=/catalog" });
    expect(login.statusCode).toBe(302);
    const request = decodeRedirectRequest(login.headers.location as string);
    const response = signedResponse(request.requestId, "http://127.0.0.1:5090/api/auth/saml/school-saml/acs", test.idpIssuer, test.privateKey, "saml-subject");
    const completed = await test.app.inject({
      method: "POST",
      url: "/api/auth/saml/school-saml/acs",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(login, "prg32_saml_correlation") },
      payload: new URLSearchParams({ SAMLResponse: Buffer.from(response, "utf8").toString("base64"), RelayState: request.relayState }).toString()
    });
    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe("/catalog");
    const session = cookie(completed, "prg32_ts_session");
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { cookie: session } })).statusCode).toBe(200);

    const replay = await test.app.inject({
      method: "POST",
      url: "/api/auth/saml/school-saml/acs",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(login, "prg32_saml_correlation") },
      payload: new URLSearchParams({ SAMLResponse: Buffer.from(response, "utf8").toString("base64"), RelayState: request.relayState }).toString()
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ ok: false, code: "saml_replay_rejected" });
    await test.app.close();
  });

  it("rejects tampered signatures, missing browser correlation, and unsolicited callbacks", async () => {
    const test = fixture();
    const login = await test.app.inject({ method: "GET", url: "/api/auth/saml/school-saml/login" });
    const request = decodeRedirectRequest(login.headers.location as string);
    const response = signedResponse(request.requestId, "http://127.0.0.1:5090/api/auth/saml/school-saml/acs", test.idpIssuer, test.privateKey, "saml-subject");
    const encoded = Buffer.from(response, "utf8").toString("base64");
    const mutationIndex = Math.floor(encoded.length / 2);
    const replacement = encoded[mutationIndex] === "A" ? "B" : "A";
    const tampered = encoded.slice(0, mutationIndex) + replacement + encoded.slice(mutationIndex + 1);
    const invalid = await test.app.inject({ method: "POST", url: "/api/auth/saml/school-saml/acs", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(login, "prg32_saml_correlation") }, payload: new URLSearchParams({ SAMLResponse: tampered, RelayState: request.relayState }).toString() });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({ ok: false, code: "saml_response_invalid" });

    const missing = await test.app.inject({ method: "POST", url: "/api/auth/saml/school-saml/acs", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ SAMLResponse: encoded, RelayState: request.relayState }).toString() });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ ok: false, code: "saml_browser_binding_failed" });
    await test.app.close();
  });

  it("provisions a new SAML identity only with a disposable opt-in and never email-links", async () => {
    const test = fixture(true);
    const acsUrl = "http://127.0.0.1:5090/api/auth/saml/school-saml/acs";
    const login = await test.app.inject({ method: "GET", url: "/api/auth/saml/school-saml/login" });
    const request = decodeRedirectRequest(login.headers.location as string);
    const response = signedResponse(request.requestId, acsUrl, test.idpIssuer, test.privateKey, "new-saml-subject", { email: "new-saml@example.test" });
    const completed = await test.app.inject({
      method: "POST",
      url: "/api/auth/saml/school-saml/acs",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(login, "prg32_saml_correlation") },
      payload: new URLSearchParams({ SAMLResponse: Buffer.from(response, "utf8").toString("base64"), RelayState: request.relayState }).toString()
    });
    expect(completed.statusCode).toBe(302);
    const database = new Database(test.databasePath, { readonly: true });
    expect(database.prepare("SELECT email, password_hash, role FROM users WHERE email = ?").get("new-saml@example.test"))
      .toMatchObject({ email: "new-saml@example.test", password_hash: null, role: "user" });
    expect(database.prepare("SELECT subject, provider_id FROM user_external_identities WHERE subject = ?").get("new-saml-subject"))
      .toEqual({ subject: "new-saml-subject", provider_id: "school-saml" });
    database.close();
    await test.app.close();
  });

  it("supports bounded SAML certificate overlap and retirement", async () => {
    const test = fixture();
    const nextKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    const acsUrl = "http://127.0.0.1:5090/api/auth/saml/school-saml/acs";
    const complete = async (privateKey: string) => {
      const login = await test.app.inject({ method: "GET", url: "/api/auth/saml/school-saml/login" });
      const request = decodeRedirectRequest(login.headers.location as string);
      const response = signedResponse(request.requestId, acsUrl, test.idpIssuer, privateKey, "saml-subject");
      return test.app.inject({ method: "POST", url: "/api/auth/saml/school-saml/acs", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(login, "prg32_saml_correlation") }, payload: new URLSearchParams({ SAMLResponse: Buffer.from(response, "utf8").toString("base64"), RelayState: request.relayState }).toString() });
    };

    const database = new Database(test.databasePath);
    const providers = new FederationProviderService(database);
    providers.updateTrustedSamlCertificates("school-saml", [test.publicKey, nextKeys.publicKey], { actorUserId: 1, actorRole: "admin", reauthenticatedAt: Date.now(), requestId: "rollover-overlap" }, true);
    database.close();
    expect((await complete(nextKeys.privateKey)).statusCode).toBe(302);

    const retiredDatabase = new Database(test.databasePath);
    const retiredProviders = new FederationProviderService(retiredDatabase);
    retiredProviders.updateTrustedSamlCertificates("school-saml", [nextKeys.publicKey], { actorUserId: 1, actorRole: "admin", reauthenticatedAt: Date.now(), requestId: "rollover-retire" }, true);
    retiredDatabase.close();
    expect((await complete(test.privateKey)).statusCode).toBe(401);
    expect((await complete(nextKeys.privateKey)).statusCode).toBe(302);
    await test.app.close();
  });

  it("rejects issuer, audience, destination, recipient, and temporal mismatches", async () => {
    const test = fixture();
    const acsUrl = "http://127.0.0.1:5090/api/auth/saml/school-saml/acs";
    const cases: readonly ResponseOverrides[] = [
      { issuer: "https://wrong-idp.example.test/saml" },
      { audience: "https://wrong-sp.example.test" },
      { destination: "http://127.0.0.1:5090/wrong" },
      { recipient: "http://127.0.0.1:5090/wrong" },
      { notOnOrAfter: new Date(Date.now() - 60_000).toISOString() }
    ];
    for (const overrides of cases) {
      const login = await test.app.inject({ method: "GET", url: "/api/auth/saml/school-saml/login" });
      const request = decodeRedirectRequest(login.headers.location as string);
      const response = signedResponse(request.requestId, acsUrl, test.idpIssuer, test.privateKey, "saml-subject", overrides);
      const result = await test.app.inject({ method: "POST", url: "/api/auth/saml/school-saml/acs", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(login, "prg32_saml_correlation") }, payload: new URLSearchParams({ SAMLResponse: Buffer.from(response, "utf8").toString("base64"), RelayState: request.relayState }).toString() });
      expect(result.statusCode, JSON.stringify(overrides)).toBe(401);
    }
    await test.app.close();
  });
});
