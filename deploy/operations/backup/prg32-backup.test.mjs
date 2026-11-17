import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performRetention, selectRetention, validateArchiveName } from "./prg32-backup.mjs";

const date = (value) => new Date(value.includes("T") ? `${value}Z` : `${value}T12:00:00.000Z`);
const record = (name, timestamp, overrides = {}) => ({
  name,
  archive: `/disposable/${name}`,
  timestamp: date(timestamp),
  complete: true,
  verified: true,
  transferred: true,
  ...overrides
});

const disposableRoots = [];
const disposableRoot = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-retention-test-")); disposableRoots.push(value); return value; };

function writeArchive(directory, name, timestamp, { backupId = crypto.randomUUID(), transferred = true } = {}) {
  const archive = path.join(directory, name);
  const bytes = Buffer.from(`synthetic-${backupId}`);
  fs.writeFileSync(archive, bytes, { mode: 0o600 });
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const complete = { abi: "prg32-cartridge-store-backup-4.0", archive_bytes: bytes.length, archive_sha256: sha256, backup_id: backupId, completed_at: new Date(timestamp).toISOString() };
  const verified = { verification_state: "complete", archive_bytes: bytes.length, archive_sha256: sha256, verified_at: new Date(timestamp).toISOString() };
  fs.writeFileSync(`${archive}.complete.json`, `${JSON.stringify(complete)}\n`, { mode: 0o600 });
  fs.writeFileSync(`${archive}.verified.json`, `${JSON.stringify(verified)}\n`, { mode: 0o600 });
  if (transferred) fs.writeFileSync(`${archive}.transferred.json`, `${JSON.stringify({ archive_sha256: sha256, transferred_at: new Date(timestamp).toISOString(), transfer_status: "operator_confirmed" })}\n`, { mode: 0o600 });
  fs.utimesSync(archive, new Date(timestamp), new Date(timestamp));
  return archive;
}

test.afterEach(() => { for (const root of disposableRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("calendar retention keeps daily, weekly and monthly recovery points", () => {
  const records = [
    record("prg32-20261015T120000Z-new.backup4", "2026-10-15"),
    record("prg32-20261014T120000Z-daily.backup4", "2026-10-14"),
    record("prg32-20261001T120000Z-month.backup4", "2026-10-01"),
    record("prg32-20260901T120000Z-old.backup4", "2026-09-01"),
    record("prg32-20260801T120000Z-older.backup4", "2026-08-01"),
    record("prg32-20260701T120000Z-expired.backup4", "2026-07-01"),
    record("prg32-20260601T120000Z-expired2.backup4", "2026-06-01")
  ];
  const result = selectRetention(records, { daily: 2, weekly: 2, monthly: 2 });
  assert.ok(result.protected.includes(records[0].name));
  assert.ok(result.protected.includes(records[2].name));
  assert.ok(result.candidates.includes(records.at(-1).name));
});

test("untransferred and unverified archives are always protected", () => {
  const records = [
    record("prg32-20261015T120000Z-valid.backup4", "2026-10-15"),
    record("prg32-20260101T120000Z-untransferred.backup4", "2026-01-01", { transferred: false }),
    record("prg32-20251201T120000Z-unverified.backup4", "2025-12-01", { verified: false })
  ];
  const result = selectRetention(records, { daily: 0, weekly: 0, monthly: 0 });
  assert.deepEqual(result.candidates, []);
  assert.ok(result.protected.includes(records[1].name));
  assert.ok(result.protected.includes(records[2].name));
});

test("same-day archives select the newest archive for a day bucket", () => {
  const records = [
    record("prg32-20261015T120000Z-latest.backup4", "2026-10-15T12:00:00.000"),
    record("prg32-20261015T080000Z-earlier.backup4", "2026-10-15T08:00:00.000"),
    record("prg32-20261014T120000Z-old.backup4", "2026-10-14")
  ];
  const result = selectRetention(records, { daily: 1, weekly: 0, monthly: 0 });
  assert.ok(result.protected.includes(records[0].name));
  assert.ok(result.candidates.includes(records[1].name));
});

test("applies actual deletion only after marker and checksum validation", async () => {
  const directory = disposableRoot();
  const oldArchive = writeArchive(directory, "prg32-20260101T120000Z-old.backup4", "2026-01-01T12:00:00.000Z");
  const newestArchive = writeArchive(directory, "prg32-20261015T120000Z-new.backup4", "2026-10-15T12:00:00.000Z");
  const result = await performRetention({ directory, apply: true, policy: { daily: 0, weekly: 0, monthly: 0 } });
  assert.deepEqual(result.deleted, [path.basename(oldArchive)]);
  assert.equal(fs.existsSync(oldArchive), false);
  assert.equal(fs.existsSync(`${oldArchive}.complete.json`), false);
  assert.equal(fs.existsSync(newestArchive), true);
});

test("preserves unknown files and fails closed on malformed archive metadata or symlinks", async () => {
  const directory = disposableRoot();
  writeArchive(directory, "prg32-20261015T120000Z-valid.backup4", "2026-10-15T12:00:00.000Z");
  const malformed = path.join(directory, "prg32-20260101T120000Z-malformed.backup4");
  fs.writeFileSync(malformed, "malformed", { mode: 0o600 });
  fs.writeFileSync(`${malformed}.complete.json`, "not-json\n", { mode: 0o600 });
  const unknown = path.join(directory, "operator-note.txt");
  fs.writeFileSync(unknown, "preserve me");
  const symlink = path.join(directory, "prg32-20250101T120000Z-link.backup4");
  fs.symlinkSync(malformed, symlink);
  await assert.rejects(() => performRetention({ directory, apply: true, policy: { daily: 0, weekly: 0, monthly: 0 } }), { code: "retention_inventory_inconsistent" });
  assert.equal(fs.existsSync(unknown), true);
  assert.equal(fs.existsSync(malformed), true);
  assert.equal(fs.existsSync(symlink), true);
});

test("blocks concurrent retention and protects a required newly-created archive", async () => {
  const directory = disposableRoot();
  const oldArchive = writeArchive(directory, "prg32-20260101T120000Z-old.backup4", "2026-01-01T12:00:00.000Z");
  const newestArchive = writeArchive(directory, "prg32-20261015T120000Z-new.backup4", "2026-10-15T12:00:00.000Z");
  fs.writeFileSync(path.join(directory, ".prg32-backup.lock"), "active\n", { mode: 0o600 });
  await assert.rejects(() => performRetention({ directory, apply: true, policy: { daily: 0, weekly: 0, monthly: 0 } }), { code: "backup_lock_busy" });
  fs.unlinkSync(path.join(directory, ".prg32-backup.lock"));
  await assert.rejects(() => performRetention({ directory, apply: true, requiredArchive: oldArchive, policy: { daily: 0, weekly: 0, monthly: 0 } }), { code: "retention_required_archive_candidate" });
  assert.equal(fs.existsSync(oldArchive), true);
  assert.equal(fs.existsSync(newestArchive), true);
});

test("rejects unsafe archive identifiers and duplicate backup identifiers", async () => {
  assert.equal(validateArchiveName("../outside.backup4"), false);
  assert.equal(validateArchiveName("prg32-safe.backup4"), true);
  const directory = disposableRoot();
  writeArchive(directory, "prg32-20261015T120000Z-one.backup4", "2026-10-15T12:00:00.000Z", { backupId: "duplicate" });
  writeArchive(directory, "prg32-20260101T120000Z-two.backup4", "2026-01-01T12:00:00.000Z", { backupId: "duplicate" });
  await assert.rejects(() => performRetention({ directory, apply: true, policy: { daily: 0, weekly: 0, monthly: 0 } }), { code: "retention_inventory_inconsistent" });
});
