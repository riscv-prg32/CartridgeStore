import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { applyFederationMigrations } from "../src/db/federation-migrations.js";
import { FederationIdentityService } from "../src/federation/identity.js";
import { FederationProviderOperations } from "../src/federation/operations.js";
import { FederationProviderService } from "../src/federation/provider.js";
import { FederationTransactionStore } from "../src/federation/transaction.js";
import { SecretStore } from "../src/secrets/service.js";

const roots: string[] = [];

function database(): Database.Database {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-federation-lifecycle-"));
  roots.push(root);
  const db = new Database(path.join(root, "auth.sqlite"));
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT); CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT); CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE); CREATE TABLE user_groups (user_id INTEGER NOT NULL, group_id INTEGER NOT NULL, PRIMARY KEY(user_id, group_id)); CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT); CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO users(username,email,password_hash,role) VALUES ('alice','alice@example.test','local-hash','user');");
  applyFederationMigrations(db);
  return db;
}

function publicKey(): string {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } }).publicKey;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("federation lifecycle", () => {
  it("invalidates pending transactions across disable and re-enable", () => {
    const db = database();
    try {
      const providers = new FederationProviderService(db);
      providers.create({ providerId: "school", protocol: "oidc", displayName: "School", issuer: "https://id.example.test", scopes: ["openid"] });
      const enabled = providers.setEnabled("school", true);
      const transactions = new FederationTransactionStore(db, "lifecycle-secret-that-is-at-least-32-bytes", providers);
      const pending = transactions.create({ protocol: "oidc", providerId: "school", callbackBinding: "binding", state: "state-value-that-is-at-least-thirty-two-bytes", returnPath: "/" });
      expect(enabled.generation).toBeGreaterThan(1);
      expect(providers.pendingTransactionCount("school")).toBe(1);
      providers.setEnabled("school", false);
      expect(providers.pendingTransactionCount("school")).toBe(0);
      providers.setEnabled("school", true);
      expect(transactions.wasConsumed(pending.transactionId)).toBe(true);
      expect(() => transactions.consume({ transactionId: pending.transactionId, protocol: "oidc", providerId: "school", callbackBinding: "binding", state: pending.state })).toThrowError(/already consumed|revoked/);
    } finally { db.close(); }
  });

  it("enforces bounded A+B trust and rejects duplicate certificates", () => {
    const db = database();
    try {
      const providers = new FederationProviderService(db);
      const a = publicKey();
      const b = publicKey();
      const created = providers.create({
        providerId: "school-saml", protocol: "saml", displayName: "School SAML", issuer: "https://id.example.test/saml",
        idpEntityId: "https://id.example.test/saml", spEntityId: "https://store.example.test/sp", acsUrl: "https://store.example.test/api/auth/saml/school-saml/acs",
        samlEntryPoint: "https://id.example.test/sso", samlNameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", samlIdpCertificatePem: a
      });
      expect(created.samlTrustedCertificatesPem).toHaveLength(1);
      const rolled = providers.updateTrustedSamlCertificates("school-saml", [a, b]);
      expect(rolled.samlTrustedCertificatesPem).toEqual([a.trim(), b.trim()]);
      expect(() => providers.updateTrustedSamlCertificates("school-saml", [a, a])).toThrowError(/duplicates/);
      expect(() => providers.updateTrustedSamlCertificates("school-saml", [a, b, publicKey()])).toThrowError(/invalid/);
    } finally { db.close(); }
  });

  it("reports safe provider operations without exposing secret material", () => {
    const db = database();
    try {
      const providers = new FederationProviderService(db);
      providers.create({ providerId: "school", protocol: "oidc", displayName: "School", issuer: "https://id.example.test", scopes: ["openid"] });
      providers.setEnabled("school", true);
      const transactions = new FederationTransactionStore(db, "lifecycle-secret-that-is-at-least-32-bytes", providers);
      const identities = new FederationIdentityService(db, providers);
      const operations = new FederationProviderOperations(db, providers, transactions, identities, new SecretStore());
      const status = operations.status("school");
      expect(status).toMatchObject({ providerId: "school", protocol: "oidc", enabled: true, pendingTransactions: 0 });
      expect(JSON.stringify(status)).not.toContain("secret");
    } finally { db.close(); }
  });
});
