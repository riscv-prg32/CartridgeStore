import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { applyFederationMigrations, FEDERATION_SCHEMA_VERSION } from "../src/db/federation-migrations.js";
import { FederationIdentityError, FederationIdentityService, ValidatedExternalIdentity } from "../src/federation/identity.js";
import { FederationProviderService } from "../src/federation/provider.js";
import { FederationTransactionError, FederationTransactionStore } from "../src/federation/transaction.js";

const roots: string[] = [];

function database(): Database.Database {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-federation-foundation-"));
  roots.push(root);
  const db = new Database(path.join(root, "auth.sqlite"));
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT); CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT); CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE); CREATE TABLE user_groups (user_id INTEGER NOT NULL, group_id INTEGER NOT NULL, PRIMARY KEY(user_id, group_id)); CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT); CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO users(username,email,password_hash,role) VALUES ('alice','alice@example.test','local-hash','user'); INSERT INTO users(username,email,password_hash,role) VALUES ('admin','admin@example.test','local-hash','admin');");
  return db;
}

function identity(subject: string): ValidatedExternalIdentity {
  return ValidatedExternalIdentity.fromProtocolAdapter({ protocol: "oidc", providerId: "school", issuer: "https://id.example.test/", subject, email: subject + "@example.test", authenticatedAt: new Date().toISOString() });
}

function publicKey(): string {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } }).publicKey;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("federated identity foundation", () => {
  it("applies an additive, idempotent writer-only migration and binds providers exactly", () => {
    const db = database();
    try {
      applyFederationMigrations(db);
      applyFederationMigrations(db);
      expect((db.pragma("user_version") as Array<{ user_version: number }>)[0]?.user_version).toBe(FEDERATION_SCHEMA_VERSION);
      expect(db.prepare("SELECT disabled_at FROM users WHERE id = 1").get()).toEqual({ disabled_at: null });
      const providers = new FederationProviderService(db);
      const created = providers.create({ providerId: "school", protocol: "oidc", displayName: "School IdP", issuer: "https://id.example.test", scopes: ["openid"] });
      expect(created.enabled).toBe(false);
      expect(() => providers.create({ providerId: "other", protocol: "oidc", displayName: "Other", issuer: "http://id.example.test" }, undefined, false)).toThrowError(/HTTPS/);
      providers.setEnabled("school", true);
      expect(providers.enabled("school", "oidc").issuer).toBe("https://id.example.test/");
    } finally { db.close(); }
  });

  it("does not auto-link identities and preserves retired-identity uniqueness", () => {
    const db = database();
    try {
      applyFederationMigrations(db);
      const providers = new FederationProviderService(db);
      providers.create({ providerId: "school", protocol: "oidc", displayName: "School IdP", issuer: "https://id.example.test" });
      providers.setEnabled("school", true);
      const service = new FederationIdentityService(db, providers);
      const auth = { actorUserId: 1, actorRole: "user" as const, reauthenticatedAt: Date.now(), requestId: "test-link" };
      const linked = service.link(identity("alice"), 1, auth);
      expect(service.resolve(identity("alice")).userId).toBe(1);
      expect(() => service.resolve(identity("unlinked"))).toThrowError(FederationIdentityError);
      service.unlink(linked.identityId, auth);
      expect(() => service.link(identity("alice"), 1, auth)).toThrowError(/reserved/);
      db.prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = 1").run();
      expect(() => service.resolve(identity("alice"))).toThrowError(/not linked|disabled/);
    } finally { db.close(); }
  });

  it("migrates an unambiguous historical external identity without using email matching", () => {
    const db = database();
    try {
      applyFederationMigrations(db);
      db.prepare("UPDATE users SET external_provider = ?, external_id = ? WHERE id = 1").run("school", "legacy-subject");
      const providers = new FederationProviderService(db);
      providers.create({ providerId: "school", protocol: "oidc", displayName: "School IdP", issuer: "https://id.example.test" });
      const service = new FederationIdentityService(db, providers);
      expect(service.migrateLegacyMappings()).toEqual({ migrated: 1, alreadyMapped: 0, skipped: 0 });
      expect(service.migrateLegacyMappings()).toEqual({ migrated: 0, alreadyMapped: 1, skipped: 0 });
      expect(db.prepare("SELECT user_id, provider_id, issuer, subject FROM user_external_identities").get()).toEqual({ user_id: 1, provider_id: "school", issuer: "https://id.example.test/", subject: "legacy-subject" });
    } finally { db.close(); }
  });

  it("consumes correlation state once, protects PKCE, and rejects replay or binding changes", () => {
    const db = database();
    try {
      applyFederationMigrations(db);
      const providers = new FederationProviderService(db);
      providers.create({ providerId: "school", protocol: "oidc", displayName: "School IdP", issuer: "https://id.example.test" });
      providers.setEnabled("school", true);
      const store = new FederationTransactionStore(db, "transaction-secret-that-is-at-least-32-bytes", providers);
      const created = store.create({ protocol: "oidc", providerId: "school", callbackBinding: "https://store.example.test/callback", state: "state-value-with-at-least-thirty-two-bytes", nonce: "nonce-value", pkceVerifier: "pkce-verifier-value", requestId: "request-1", returnPath: "/dashboard/account" });
      const consumed = store.consume({ transactionId: created.transactionId, protocol: "oidc", providerId: "school", callbackBinding: "https://store.example.test/callback", state: created.state });
      expect(consumed.pkceVerifier).toBe("pkce-verifier-value");
      expect(() => store.consume({ transactionId: created.transactionId, protocol: "oidc", providerId: "school", callbackBinding: "https://store.example.test/callback", state: created.state })).toThrowError(FederationTransactionError);
      const second = store.create({ protocol: "oidc", providerId: "school", callbackBinding: "callback", state: "another-state-value-with-at-least-thirty-two-bytes", returnPath: "/" });
      expect(() => store.consume({ transactionId: second.transactionId, protocol: "oidc", providerId: "school", callbackBinding: "wrong", state: "another-state-value-with-at-least-thirty-two-bytes" })).toThrowError(/invalid/);
      store.recordReplay("oidc", "school", "assertion-1");
      expect(() => store.recordReplay("oidc", "school", "assertion-1")).toThrowError(/already used/);
    } finally { db.close(); }
  });

  it("allows at most one duplicate callback consumer across independent SQLite handles", async () => {
    const db = database();
    const databaseFile = (db.pragma("database_list") as Array<{ file: string }>)[0]?.file;
    if (!databaseFile) throw new Error("test database path unavailable");
    const second = new Database(databaseFile);
    try {
      applyFederationMigrations(db);
      applyFederationMigrations(second);
      const providers = new FederationProviderService(db);
      const secondProviders = new FederationProviderService(second);
      providers.create({ providerId: "school", protocol: "saml", displayName: "School SAML", issuer: "https://id.example.test/saml", idpEntityId: "https://id.example.test/saml", spEntityId: "https://store.example.test/sp", acsUrl: "https://store.example.test/api/auth/saml/school/acs", samlEntryPoint: "https://id.example.test/sso", samlNameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", samlIdpCertificatePem: publicKey() });
      providers.setEnabled("school", true);
      const first = new FederationTransactionStore(db, "transaction-secret-that-is-at-least-32-bytes", providers);
      const duplicate = new FederationTransactionStore(second, "transaction-secret-that-is-at-least-32-bytes", secondProviders);
      const pending = first.create({ protocol: "saml", providerId: "school", callbackBinding: "acs-binding", state: "state-value-with-at-least-thirty-two-bytes", requestId: "saml-request-1", returnPath: "/dashboard/account" });
      const results = await Promise.allSettled([
        Promise.resolve().then(() => first.consume({ transactionId: pending.transactionId, protocol: "saml", providerId: "school", callbackBinding: "acs-binding", state: pending.state })),
        Promise.resolve().then(() => duplicate.consume({ transactionId: pending.transactionId, protocol: "saml", providerId: "school", callbackBinding: "acs-binding", state: pending.state }))
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      second.close();
      db.close();
    }
  });
});
