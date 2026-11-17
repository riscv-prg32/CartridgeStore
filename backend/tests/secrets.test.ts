import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { decryptSecret, ENVELOPE_PREFIX, encryptSecret, parseEnvelope } from "../src/secrets/envelope.js";
import { KeyRegistry, generateRegistryDocument, SecretKeyError } from "../src/secrets/registry.js";
import { SecretStore } from "../src/secrets/service.js";

const roots: string[] = [];

function registry(root: string, keys: readonly { readonly id: string; readonly status: "active" | "decrypt-only"; readonly material: Buffer }[], activeKeyId: string): string {
  const filePath = path.join(root, "keys.json");
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, active_key_id: activeKeyId, keys: keys.map((key) => ({ id: key.id, status: key.status, key: key.material.toString("base64url") })) }) + "\n", { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function database(root: string, values: Record<string, string> = {}): { readonly path: string; readonly db: Database.Database } {
  const databasePath = path.join(root, "auth.sqlite");
  const db = new Database(databasePath);
  db.exec("CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO store_settings(key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(values)) insert.run(key, value);
  return { path: databasePath, db };
}

function value(db: Database.Database, key: string): string {
  return (db.prepare("SELECT value FROM store_settings WHERE key = ?").get(key) as { value: string }).value;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("secret encryption", () => {
  it("uses authenticated, purpose-separated, nonce-unique envelopes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-secrets-"));
    roots.push(root);
    const firstKey = Buffer.alloc(32, 1);
    const registryPath = registry(root, [{ id: "key-1", status: "active", material: firstKey }], "key-1");
    const keys = KeyRegistry.fromFile(registryPath, path.join(root, "data"));
    const first = encryptSecret(keys, "smtp_password", "store-setting:smtp-password", "pässword");
    const second = encryptSecret(keys, "smtp_password", "store-setting:smtp-password", "pässword");
    expect(first.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(second).not.toBe(first);
    expect(decryptSecret(keys, "smtp_password", "store-setting:smtp-password", first)).toBe("pässword");
    expect(decryptSecret(keys, "smtp_password", "store-setting:smtp-password", encryptSecret(keys, "smtp_password", "store-setting:smtp-password", ""))).toBe("");
    expect(() => decryptSecret(keys, "oidc_client_secret", "store-setting:smtp-password", first)).toThrowError(/purpose|authentication/i);
    expect(() => decryptSecret(keys, "smtp_password", "store-setting:smtp-password", first.slice(0, -1) + (first.endsWith("A") ? "B" : "A"))).toThrowError(/authentication|malformed|invalid/i);
    expect(() => parseEnvelope(ENVELOPE_PREFIX + "!")).toThrowError(/invalid/i);
    const unsupported = ENVELOPE_PREFIX + Buffer.from(JSON.stringify({ v: 2, purpose: "store-setting:smtp-password", key_id: "key-1", kdf: "hkdf-sha256", cipher: "aes-256-gcm", nonce: "AA", ciphertext: "", tag: "AA" })).toString("base64url");
    expect(() => parseEnvelope(unsupported)).toThrowError(/metadata|version/i);
  });

  it("rejects weak or ambiguous external key registries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-key-registry-"));
    roots.push(root);
    const duplicate = path.join(root, "duplicate.json");
    fs.writeFileSync(duplicate, JSON.stringify({ version: 1, active_key_id: "key-1", keys: [
      { id: "key-1", status: "active", key: Buffer.alloc(32, 1).toString("base64url") },
      { id: "key-1", status: "decrypt-only", key: Buffer.alloc(32, 2).toString("base64url") }
    ] }), { mode: 0o600 });
    expect(() => KeyRegistry.fromFile(duplicate)).toThrowError(SecretKeyError);
    const permissive = path.join(root, "permissive.json");
    fs.writeFileSync(permissive, generateRegistryDocument("key-1"), { mode: 0o644 });
    fs.chmodSync(permissive, 0o644);
    expect(() => KeyRegistry.fromFile(permissive)).toThrowError(/permissions/i);
  });

  it("migrates only classified legacy values, supports encrypted rollback, and is idempotent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-secret-migration-"));
    roots.push(root);
    const dataRoot = path.join(root, "data");
    fs.mkdirSync(dataRoot, { mode: 0o700 });
    const registryPath = registry(root, [{ id: "key-1", status: "active", material: Buffer.alloc(32, 3) }], "key-1");
    const created = database(root, { smtp_password: "smtp-secret", oidc_client_secret: "oidc-secret", saml_idp_x509cert: "public-cert", store_name: "Store" });
    const store = new SecretStore({ keyRegistryPath: registryPath, applicationDataRoot: dataRoot });
    const snapshotPath = path.join(root, "migration.snapshot.json");
    const dry = store.migrate(created.db, created.path, { confirm: false, snapshotPath });
    expect(dry.converted).toEqual([]);
    expect(value(created.db, "smtp_password")).toBe("smtp-secret");
    const migrated = store.migrate(created.db, created.path, { confirm: true, snapshotPath });
    expect(migrated.converted).toEqual(["smtp_password", "oidc_client_secret"]);
    expect(value(created.db, "smtp_password")).toMatch(/^prg32enc:v1:/);
    expect(value(created.db, "saml_idp_x509cert")).toBe("public-cert");
    expect(store.migrate(created.db, created.path, { confirm: true, snapshotPath }).converted).toEqual([]);
    store.rollback(created.db, created.path, snapshotPath, true);
    expect(value(created.db, "smtp_password")).toBe("smtp-secret");
    expect(value(created.db, "oidc_client_secret")).toBe("oidc-secret");
    expect(fs.existsSync(snapshotPath)).toBe(false);
    created.db.close();
  });

  it("rolls back interrupted migration and rotation transactionally", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-secret-recovery-"));
    roots.push(root);
    const dataRoot = path.join(root, "data");
    fs.mkdirSync(dataRoot, { mode: 0o700 });
    const oldMaterial = Buffer.alloc(32, 4);
    const newMaterial = Buffer.alloc(32, 5);
    const oldRegistryPath = registry(root, [{ id: "old", status: "active", material: oldMaterial }], "old");
    const created = database(root, { smtp_password: "smtp-secret", oidc_client_secret: "oidc-secret" });
    const oldStore = new SecretStore({ keyRegistryPath: oldRegistryPath, applicationDataRoot: dataRoot });
    const snapshotPath = path.join(root, "migration.snapshot.json");
    expect(() => oldStore.migrate(created.db, created.path, { confirm: true, snapshotPath, fault: (point) => { if (point === "after-write") throw new Error("fault"); } })).toThrow("fault");
    expect(value(created.db, "smtp_password")).toBe("smtp-secret");
    expect(fs.existsSync(snapshotPath)).toBe(false);
    oldStore.migrate(created.db, created.path, { confirm: true, snapshotPath });
    const newRegistryPath = registry(root, [
      { id: "old", status: "decrypt-only", material: oldMaterial },
      { id: "new", status: "active", material: newMaterial }
    ], "new");
    const rotatedStore = new SecretStore({ keyRegistryPath: newRegistryPath, applicationDataRoot: dataRoot });
    const beforeRotation = value(created.db, "smtp_password");
    expect(() => rotatedStore.rotate(created.db, { fault: () => { throw new Error("rotation fault"); } })).toThrow("rotation fault");
    expect(value(created.db, "smtp_password")).toBe(beforeRotation);
    const result = rotatedStore.rotate(created.db, {});
    expect(result.rotated).toBe(2);
    expect(parseEnvelope(value(created.db, "smtp_password")).key_id).toBe("new");
    expect(rotatedStore.decrypt(created.db, "smtp_password")).toBe("smtp-secret");
    created.db.close();
  });

  it("fails closed when encrypted values have no usable key registry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-secret-failclosed-"));
    roots.push(root);
    const registryPath = registry(root, [{ id: "key-1", status: "active", material: Buffer.alloc(32, 6) }], "key-1");
    const created = database(root);
    const store = new SecretStore({ keyRegistryPath: registryPath });
    created.db.prepare("INSERT INTO store_settings(key, value) VALUES (?, ?)").run("smtp_password", store.encrypt("smtp_password", "secret"));
    const noKeys = new SecretStore();
    expect(() => noKeys.validateDatabase(created.db)).toThrowError(/registry|key/i);
    created.db.close();
  });
});
