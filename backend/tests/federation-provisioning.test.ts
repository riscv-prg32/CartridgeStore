import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { applyFederationMigrations } from "../src/db/federation-migrations.js";
import { FederationIdentityError, FederationIdentityService, ValidatedExternalIdentity } from "../src/federation/identity.js";
import { FederationProviderError, FederationProviderService } from "../src/federation/provider.js";
import {
  FEDERATION_PROVISIONING_AUTHORIZATION,
  inventoryLegacyFederationSettings,
  provisionFederation
} from "../src/federation/provisioning.js";
import { CanonicalWriterLease } from "../src/storage-v2/writer-lock.js";

const roots: string[] = [];

function publicKey(): string {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" }
  }).publicKey;
}

function database(): { readonly db: Database.Database; readonly root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-federation-provisioning-"));
  roots.push(root);
  const db = new Database(path.join(root, "auth.sqlite"));
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      external_id TEXT,
      external_provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT
    );
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO users(id, username, email, external_id, external_provider) VALUES (1, 'oidc-user', 'oidc@example.test', 'oidc-subject', 'legacy-oidc');
    INSERT INTO users(id, username, email, external_id, external_provider) VALUES (2, 'saml-user', 'saml@example.test', 'saml-nameid', 'legacy-saml');
  `);
  applyFederationMigrations(db);
  db.prepare("UPDATE users SET disabled_at = ? WHERE id = 2").run("2026-10-01T00:00:00Z");
  return { db, root };
}

function document(cert: string) {
  return {
    version: 1 as const,
    providers: [
      {
        providerId: "campus-oidc",
        protocol: "oidc" as const,
        displayName: "Campus OIDC",
        issuer: "https://id.example.test",
        clientId: "store-client",
        clientAuthMethod: "none" as const,
        redirectUri: "https://api.example.test/api/auth/oidc/campus-oidc/callback",
        scopes: ["openid", "email"],
        legacyProviderIds: ["legacy-oidc"]
      },
      {
        providerId: "campus-saml",
        protocol: "saml" as const,
        displayName: "Campus SAML",
        issuer: "https://id.example.test/saml",
        idpEntityId: "https://id.example.test/saml",
        spEntityId: "https://store.example.test/saml/sp",
        acsUrl: "https://api.example.test/api/auth/saml/campus-saml/acs",
        samlEntryPoint: "https://id.example.test/sso",
        samlNameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        samlIdpCertificatePem: cert,
        legacyProviderIds: ["legacy-saml"]
      }
    ]
  };
}

function options(db: Database.Database, root: string, value: ReturnType<typeof document>) {
  return {
    database: db,
    providers: new FederationProviderService(db),
    identities: new FederationIdentityService(db, new FederationProviderService(db)),
    document: value,
    authorization: FEDERATION_PROVISIONING_AUTHORIZATION,
    mode: "apply" as const,
    writerRoot: root,
    apiOrigin: "https://api.example.test",
    storeOrigin: "https://store.example.test"
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("offline federation provisioning and identity continuity", () => {
  it("provisions OIDC and SAML deterministically, migrates exact identities, preserves disabled state, and retries idempotently", () => {
    const fixture = database();
    try {
      const value = document(publicKey());
      const first = provisionFederation(options(fixture.db, fixture.root, value));
      expect(first.identityMigration).toEqual({ migrated: 2, alreadyMapped: 0, skipped: 0 });
      expect(fixture.db.prepare("SELECT provider_id, enabled FROM federation_providers ORDER BY provider_id").all()).toEqual([
        { provider_id: "campus-oidc", enabled: 0 },
        { provider_id: "campus-saml", enabled: 0 }
      ]);
      expect(fixture.db.prepare("SELECT user_id, provider_id, subject FROM user_external_identities ORDER BY user_id").all()).toEqual([
        { user_id: 1, provider_id: "campus-oidc", subject: "oidc-subject" },
        { user_id: 2, provider_id: "campus-saml", subject: "saml-nameid" }
      ]);
      expect(fixture.db.prepare("SELECT disabled_at FROM users WHERE id = 2").get()).toEqual({ disabled_at: "2026-10-01T00:00:00Z" });
      const providers = new FederationProviderService(fixture.db);
      providers.setEnabled("campus-oidc", true);
      providers.setEnabled("campus-saml", true);
      const identities = new FederationIdentityService(fixture.db, providers);
      expect(identities.resolve(ValidatedExternalIdentity.fromProtocolAdapter({ protocol: "oidc", providerId: "campus-oidc", issuer: "https://id.example.test/", subject: "oidc-subject", authenticatedAt: new Date().toISOString() })).userId).toBe(1);
      expect(() => identities.resolve(ValidatedExternalIdentity.fromProtocolAdapter({ protocol: "saml", providerId: "campus-saml", issuer: "https://id.example.test/saml", subject: "saml-nameid", authenticatedAt: new Date().toISOString() }))).toThrowError(/disabled/);
      const retry = provisionFederation(options(fixture.db, fixture.root, value));
      expect(retry.alreadyPresent).toEqual(["campus-oidc", "campus-saml"]);
      expect(retry.identityMigration).toEqual({ migrated: 0, alreadyMapped: 2, skipped: 0 });
    } finally { fixture.db.close(); }
  });

  it("rejects ambiguous mappings, inline secrets, activation and callback origin mistakes before writing", () => {
    const fixture = database();
    try {
      const base = document(publicKey());
      expect(() => provisionFederation({ ...options(fixture.db, fixture.root, { ...base, providers: [{ ...base.providers[0], legacyProviderIds: ["oidc"] }, { ...base.providers[1], legacyProviderIds: ["oidc"] }] }), mode: "validate" })).toThrowError(/multiple canonical providers|multiple/);
      expect(() => provisionFederation({ ...options(fixture.db, fixture.root, { ...base, providers: [{ ...base.providers[0], clientSecret: "do-not-store" }] }), mode: "validate" })).toThrowError(FederationProviderError);
      expect(() => provisionFederation({ ...options(fixture.db, fixture.root, { ...base, providers: [{ ...base.providers[0], enabled: true }] }), mode: "validate" })).toThrowError(/enable/);
      expect(() => provisionFederation({ ...options(fixture.db, fixture.root, { ...base, providers: [{ ...base.providers[0], redirectUri: "https://store.example.test/api/auth/oidc/campus-oidc/callback" }] }), mode: "validate" })).toThrowError(/API origin/);
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM federation_providers").get()).toEqual({ count: 0 });
    } finally { fixture.db.close(); }
  });

  it("fails closed for unknown identities and for a held canonical writer lease", () => {
    const fixture = database();
    const lease = new CanonicalWriterLease(fixture.root);
    try {
      const base = document(publicKey());
      expect(() => provisionFederation({ ...options(fixture.db, fixture.root, { ...base, providers: [{ ...base.providers[0], legacyProviderIds: ["missing-legacy-id"] }, base.providers[1]] }), mode: "apply" })).toThrowError(FederationIdentityError);
      expect(() => provisionFederation(options(fixture.db, fixture.root, base))).toThrowError(/canonical writer is already active/);
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM federation_providers").get()).toEqual({ count: 0 });
    } finally { lease.close(); fixture.db.close(); }
  });

  it("redacts legacy settings inventory and never returns secret values", () => {
    const inventory = inventoryLegacyFederationSettings(
      { PRG32_OIDC_CLIENT_SECRET: "secret-value" },
      { oidc_issuer: "https://id.example.test", oidc_client_secret: "stored-secret" }
    );
    const secret = inventory.find((item) => item.field === "oidc_client_secret");
    expect(secret).toMatchObject({ present: true, classification: "SECRET_VALUE", operatorInputRequired: true });
    expect(JSON.stringify(inventory)).not.toContain("secret-value");
    expect(JSON.stringify(inventory)).not.toContain("stored-secret");
  });
});
