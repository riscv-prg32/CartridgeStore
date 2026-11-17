import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  ENCRYPTED_BACKUP_V4_AUTHORIZATION,
  InMemoryBackupKeyProvider,
  RETENTION_AUTHORIZATION,
  applyBackupRetention,
  createEncryptedCanonicalBackup,
  initializeDisposableStorage,
  CanonicalWriterLease,
  KeyRegistryBackupKeyProvider,
  rotateBackupKeyRegistry,
  ObjectStore,
  restoreEncryptedBackup,
  verifyEncryptedBackup
} from "../src/storage-v2/index.js";
import { KeyRegistry, generateRegistryDocument } from "../src/secrets/registry.js";
import { applyFederationMigrations } from "../src/db/federation-migrations.js";
import { FederationIdentityService, ValidatedExternalIdentity } from "../src/federation/identity.js";
import { FederationProviderService } from "../src/federation/provider.js";

const roots: string[] = [];

function root(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(value); return value;
}

function hashFile(filePath: string): string { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }

function seed(rootPath: string): void {
  const resource = initializeDisposableStorage(rootPath);
  resource.sqlite.prepare("INSERT INTO users(username, email, role) VALUES ('fixture', 'fixture@example.test', 'user')").run();
  resource.sqlite.prepare("INSERT INTO application_settings(setting_key, value_json, value_type, category, sensitivity, updated_at) VALUES ('registration.enabled', 'false', 'boolean', 'registration', 'admin', '2026-01-01T00:00:00.000Z')").run();
  resource.sqlite.prepare("INSERT INTO admin_audit_events(event_id, timestamp, actor_user_id, target_type, target_id, action, outcome, summary_json, request_id) VALUES ('audit-fixture', '2026-01-01T00:00:00.000Z', 1, 'settings', 'application', 'settings.update', 'committed', '{\"keys\":[\"registration.enabled\"]}', 'backup-fixture')").run();
  resource.sqlite.prepare("INSERT INTO catalog_moderation(cartridge_id, version, action, reason, actor_user_id, created_at, active) VALUES ('fixture', '1.0.0', 'hidden', 'synthetic moderation', 1, '2026-01-01T00:00:00.000Z', 1)").run();
  resource.sqlite.prepare("INSERT INTO cartridges(cartridge_id, created_at, updated_at, publisher_user_id) VALUES ('fixture', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)").run();
  resource.sqlite.prepare("INSERT INTO releases(release_id, cartridge_id, version, revision, state, title, metadata_json, created_at, published_at, published_order) VALUES ('release', 'fixture', '1.0.0', 1, 'published', 'Fixture', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)").run();
  const object = new ObjectStore(resource.sqlite, resource.paths).store("artifact", Buffer.from("synthetic cartridge"), "application/vnd.prg32.cartridge", { objectId: "obj_0123456789abcdef" });
  resource.sqlite.prepare("INSERT INTO artifacts(artifact_id, release_id, architecture, object_id, state, created_at) VALUES ('artifact', 'release', 'qemu', ?, 'published', '2026-01-01T00:00:00.000Z')").run(object.objectId);
  resource.sqlite.prepare("INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES ('fixture', 'player', 42, 1767225600, 'fixture')").run();
  resource.sqlite.prepare("INSERT INTO runs(run_id, board_id, target, game_name, started_at, submitted_by, user_id) VALUES ('run-fixture', 'board', 'qemu', 'fixture', 1767225600, 'fixture', 1)").run();
  resource.sqlite.prepare("INSERT INTO samples(run_id, frame, timestamp_ms, update_us, draw_us, present_us, frame_us, heap_free, heap_min_free, input_mask, fps_x100, upload_queue_depth) VALUES ('run-fixture', 1, 1000, 2, 3, 4, 9, 100, 90, 0, 6000, 0)").run();
  resource.sqlite.prepare("INSERT INTO download_events(cartridge_id, release_id, artifact_id, version, architecture, user_id, downloaded_at, delivery_outcome) VALUES ('fixture', 'release', 'artifact', '1.0.0', 'qemu', 1, '2026-01-01T00:00:00.000Z', 'completed')").run();
  resource.sqlite.prepare("INSERT INTO migration_exceptions(exception_id, migration_id, entity_kind, legacy_id, reason_code, payload_json, created_at) VALUES ('exception', 'migration-fixture', 'other', 'legacy-row', 'synthetic', '{}', '2026-01-01T00:00:00.000Z')").run();
  resource.sqlite.prepare("INSERT INTO store_settings(key, value) VALUES ('theme', 'dark')").run();
  applyFederationMigrations(resource.sqlite);
  resource.sqlite.prepare("UPDATE users SET external_id = ?, external_provider = ? WHERE id = 1").run("backup-subject", "legacy-backup-oidc");
  const providers = new FederationProviderService(resource.sqlite);
  providers.create({ providerId: "backup-oidc", protocol: "oidc", displayName: "Backup OIDC", issuer: "https://backup-id.example.test", clientId: "backup-client", clientAuthMethod: "none", redirectUri: "https://api.example.test/api/auth/oidc/backup-oidc/callback" });
  providers.setEnabled("backup-oidc", true);
  const identities = new FederationIdentityService(resource.sqlite, providers);
  identities.link(ValidatedExternalIdentity.fromProtocolAdapter({ protocol: "oidc", providerId: "backup-oidc", issuer: "https://backup-id.example.test/", subject: "backup-subject", authenticatedAt: new Date().toISOString() }), 1, { actorUserId: 1, actorRole: "user", reauthenticatedAt: Date.now(), requestId: "backup-fixture" });
  resource.sqlite.prepare("UPDATE users SET disabled_at = ? WHERE id = 1").run("2026-01-02T00:00:00.000Z");
  resource.sqlite.prepare("INSERT INTO auth_sessions(id_hash, user_id, csrf_token_ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run("a".repeat(64), 1, "fixture-csrf-ciphertext", 1767225600000, 1767312000000);
  resource.sqlite.prepare("INSERT INTO webauthn_credentials(credential_id, user_id, public_key, signature_counter, device_type, backed_up, transports_json, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("backup-credential", 1, Buffer.from("synthetic-public-key"), 7, "multiDevice", 1, '["internal"]', "Backup passkey", "2026-01-01T00:00:00.000Z");
  resource.sqlite.prepare("INSERT INTO webauthn_challenges(challenge_id, ceremony, challenge, user_id, session_hash, expires_at) VALUES (?, 'authentication', ?, ?, ?, ?)").run("expired-challenge", "expired-challenge-value", 1, "a".repeat(64), Date.now() - 1000);
  resource.close();
}

function provider(): InMemoryBackupKeyProvider {
  return new InMemoryBackupKeyProvider([{ id: "backup-a", status: "active", material: Buffer.alloc(32, 0x41) }]);
}

function copyBackup(source: string, destination: string): void {
  fs.copyFileSync(source, destination); fs.copyFileSync(`${source}.complete.json`, `${destination}.complete.json`);
}

afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

describe("encrypted backup-v4", () => {
  it("rotates an external registry without overwriting the source or exposing key material", () => {
    const workspace = root("prg32-backup-v4-key-rotation-"); const input = path.join(workspace, "keys-a.json"); const output = path.join(workspace, "keys-b.json");
    fs.writeFileSync(input, generateRegistryDocument("backup-a", Buffer.alloc(32, 0x41)), { mode: 0o600 });
    const result = rotateBackupKeyRegistry({ inputRegistryPath: input, outputRegistryPath: output, newKeyId: "backup-b" });
    expect(result.activeKeyId).toBe("backup-b"); expect(fs.readFileSync(input, "utf8")).toContain("backup-a"); expect(fs.readFileSync(input, "utf8")).not.toContain("backup-b");
    const rotated = new KeyRegistryBackupKeyProvider(KeyRegistry.fromFile(output));
    expect(rotated.active().id).toBe("backup-b"); expect(rotated.resolve("backup-a")?.status).toBe("decrypt-only");
  });

  it("creates, verifies, rotates and restores with historical keys", async () => {
    const workspace = root("prg32-backup-v4-rotation-"); const source = path.join(workspace, "source"); seed(source);
    const sourceHash = hashFile(path.join(source, "store.sqlite")); const keys = provider();
    const backupA = path.join(workspace, "a.backup4");
    const createdA = await createEncryptedCanonicalBackup({ sourceRoot: source, outputPath: backupA, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, writerQuiesced: true });
    expect(createdA.header.abi).toBe("prg32-cartridge-store-backup-4.0"); expect(createdA.header.key_id).toBe("backup-a");
    expect(verifyEncryptedBackup(backupA, { keyProvider: keys }).payloadManifest.object_count).toBe(1);
    keys.rotate({ id: "backup-b", status: "active", material: Buffer.alloc(32, 0x42) });
    const backupB = path.join(workspace, "b.backup4");
    await createEncryptedCanonicalBackup({ sourceRoot: source, outputPath: backupB, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, writerQuiesced: true });
    expect(verifyEncryptedBackup(backupA, { keyProvider: keys }).header.key_id).toBe("backup-a");
    expect(verifyEncryptedBackup(backupB, { keyProvider: keys }).header.key_id).toBe("backup-b");
    const restoredA = path.join(workspace, "restored-a"); const restoredB = path.join(workspace, "restored-b");
    expect(restoreEncryptedBackup({ archivePath: backupA, targetRoot: restoredA, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys }).state).toBe("completed");
    expect(restoreEncryptedBackup({ archivePath: backupB, targetRoot: restoredB, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys }).state).toBe("completed");
    expect(hashFile(path.join(source, "store.sqlite"))).toBe(sourceHash);
    const restoredDb = new Database(path.join(restoredA, "store.sqlite"), { readonly: true });
    expect(restoredDb.prepare("SELECT value FROM store_settings WHERE key = 'theme'").get()).toEqual({ value: "dark" });
    expect(restoredDb.prepare("SELECT COUNT(*) AS count FROM scores").get()).toEqual({ count: 1 });
    expect(restoredDb.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 1 });
    expect(restoredDb.prepare("SELECT COUNT(*) AS count FROM samples").get()).toEqual({ count: 1 });
    expect(restoredDb.prepare("SELECT COUNT(*) AS count FROM download_events").get()).toEqual({ count: 1 });
    expect(restoredDb.prepare("SELECT COUNT(*) AS count FROM migration_exceptions").get()).toEqual({ count: 1 });
    expect(restoredDb.prepare("SELECT provider_id, protocol, enabled FROM federation_providers").get()).toEqual({ provider_id: "backup-oidc", protocol: "oidc", enabled: 1 });
    expect(restoredDb.prepare("SELECT provider_id, subject, user_id FROM user_external_identities").get()).toEqual({ provider_id: "backup-oidc", subject: "backup-subject", user_id: 1 });
    expect(restoredDb.prepare("SELECT disabled_at FROM users WHERE id = 1").get()).toEqual({ disabled_at: "2026-01-02T00:00:00.000Z" });
    expect(restoredDb.prepare("SELECT value_json FROM application_settings WHERE setting_key = 'registration.enabled'").get()).toEqual({ value_json: "false" });
    expect(restoredDb.prepare("SELECT action FROM catalog_moderation WHERE cartridge_id = 'fixture'").get()).toEqual({ action: "hidden" });
    expect(restoredDb.prepare("SELECT action FROM admin_audit_events WHERE event_id = 'audit-fixture'").get()).toEqual({ action: "settings.update" });
    expect(restoredDb.prepare("SELECT id_hash, user_id FROM auth_sessions").get()).toEqual({ id_hash: "a".repeat(64), user_id: 1 });
    expect(restoredDb.prepare("SELECT credential_id, user_id, public_key, signature_counter, device_type, backed_up, transports_json, display_name FROM webauthn_credentials").get()).toEqual({ credential_id: "backup-credential", user_id: 1, public_key: Buffer.from("synthetic-public-key"), signature_counter: 7, device_type: "multiDevice", backed_up: 1, transports_json: '["internal"]', display_name: "Backup passkey" });
    expect(restoredDb.prepare("SELECT challenge_id, ceremony, challenge, user_id, expires_at FROM webauthn_challenges").get()).toMatchObject({ challenge_id: "expired-challenge", ceremony: "authentication", challenge: "expired-challenge-value", user_id: 1 });
    restoredDb.close();
    keys.retire("backup-a");
    expect(() => verifyEncryptedBackup(backupA, { keyProvider: keys })).toThrowError(/not usable|authentication|unavailable/);
  });

  it("rejects wrong keys, tampering, truncation and incomplete markers before restore", async () => {
    const workspace = root("prg32-backup-v4-adversarial-"); const source = path.join(workspace, "source"); seed(source); const keys = provider();
    const archive = path.join(workspace, "source.backup4"); await createEncryptedCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, writerQuiesced: true });
    const wrong = new InMemoryBackupKeyProvider([{ id: "wrong", status: "active", material: Buffer.alloc(32, 0x57) }]);
    expect(() => verifyEncryptedBackup(archive, { keyProvider: wrong })).toThrowError(/unavailable|authentication/);
    const tampered = path.join(workspace, "tampered.backup4"); copyBackup(archive, tampered); const bytes = fs.readFileSync(tampered); bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff; fs.writeFileSync(tampered, bytes);
    expect(() => verifyEncryptedBackup(tampered, { keyProvider: keys })).toThrow();
    const truncated = path.join(workspace, "truncated.backup4"); copyBackup(archive, truncated); const truncatedBytes = fs.readFileSync(truncated); fs.writeFileSync(truncated, truncatedBytes.subarray(0, truncatedBytes.length - 8));
    expect(() => verifyEncryptedBackup(truncated, { keyProvider: keys })).toThrow();
    const incomplete = path.join(workspace, "incomplete.backup4"); fs.copyFileSync(archive, incomplete);
    expect(() => verifyEncryptedBackup(incomplete, { keyProvider: keys })).toThrow(/completion marker/);
    const conflict = path.join(workspace, "conflict"); fs.mkdirSync(conflict); fs.writeFileSync(path.join(conflict, "existing"), "do not overwrite");
    expect(() => restoreEncryptedBackup({ archivePath: archive, targetRoot: conflict, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys })).toThrow();
  });

  it("quarantines interrupted encryption and keeps retention dry-run by default", async () => {
    const workspace = root("prg32-backup-v4-retention-"); const source = path.join(workspace, "source"); seed(source); const keys = provider();
    const interrupted = path.join(workspace, "interrupted.backup4"); await expect(createEncryptedCanonicalBackup({ sourceRoot: source, outputPath: interrupted, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, writerQuiesced: true, fault: (point) => { if (point === "before-envelope-finalization") throw new Error("disk-full"); } })).rejects.toThrow();
    expect(fs.existsSync(`${interrupted}.complete.json`)).toBe(false);
    const archives: string[] = [];
    for (const name of ["one", "two", "three"]) { const archive = path.join(workspace, `${name}.backup4`); await createEncryptedCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, writerQuiesced: true }); archives.push(archive); }
    const dry = applyBackupRetention({ directory: workspace, keepNewest: 1 }); expect(dry.dryRun).toBe(true); expect(dry.deleted).toEqual([]); expect(dry.candidates.length).toBe(2);
    const applied = applyBackupRetention({ directory: workspace, keepNewest: 1, protectedBackupIds: [verifyEncryptedBackup(archives[0]!, { keyProvider: keys }).backupId], apply: true, authorization: RETENTION_AUTHORIZATION });
    expect(applied.deleted.length).toBe(1);
  });

  it("respects the canonical writer lease and leaves an interrupted restore non-ready", async () => {
    const workspace = root("prg32-backup-v4-lease-"); const source = path.join(workspace, "source"); seed(source); const keys = provider();
    const lease = new CanonicalWriterLease(source);
    await expect(createEncryptedCanonicalBackup({ sourceRoot: source, outputPath: path.join(workspace, "blocked.backup4"), authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, writerQuiesced: true })).rejects.toMatchObject({ code: "canonical_writer_lock_held" });
    lease.close();
    const archive = path.join(workspace, "restore.backup4"); await createEncryptedCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, writerQuiesced: true });
    const target = path.join(workspace, "interrupted-target");
    expect(() => restoreEncryptedBackup({ archivePath: archive, targetRoot: target, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, restoreFault: (point) => { if (point === "after-sqlite-restore") throw new Error("process interrupted"); } })).toThrow();
    expect(fs.existsSync(path.join(target, ".prg32-storage-v2-restore.json"))).toBe(true);
    const restored = new Database(path.join(target, "store.sqlite"), { readonly: true });
    expect((restored.prepare("SELECT state FROM storage_metadata WHERE singleton_id = 1").get() as { state: string }).state).not.toBe("ready"); restored.close();
  });

  it("creates an online snapshot while the application writer lease and a SQLite write transaction remain active", async () => {
    const workspace = root("prg32-backup-v4-online-"); const source = path.join(workspace, "source"); seed(source); const keys = provider();
    const lease = new CanonicalWriterLease(source);
    const writer = new Database(path.join(source, "store.sqlite"));
    writer.pragma("busy_timeout = 5000");
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES (?, ?, ?, ?, ?)").run("fixture", "online-writer", 99, 1767225601, "synthetic");
      const archive = path.join(workspace, "online.backup4");
      const creating = createEncryptedCanonicalBackup({ sourceRoot: source, outputPath: archive, authorization: ENCRYPTED_BACKUP_V4_AUTHORIZATION, keyProvider: keys, writerQuiesced: false, snapshotMode: "online" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      writer.exec("COMMIT");
      await creating;
      const verified = verifyEncryptedBackup(archive, { keyProvider: keys });
      expect(verified.header.payload_format_version).toBe(3);
      expect(verified.payloadManifest.verification_state).toBe("complete");
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      lease.close();
    }
  });
});
