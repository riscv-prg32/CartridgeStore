#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const BACKUP_SUFFIX = ".backup4";
const COMPLETION_SUFFIX = ".complete.json";
const VERIFIED_SUFFIX = ".verified.json";
const TRANSFERRED_SUFFIX = ".transferred.json";
export const RETENTION_CONFIRMATION = "I_UNDERSTAND_BACKUP_DELETION";
const BACKUP_V4_ABI = "prg32-cartridge-store-backup-4.0";
const SAFE_ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.backup4$/u;
const SAFE_BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export function validateArchiveName(name) {
  return typeof name === "string" && SAFE_ARCHIVE_NAME.test(name);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail("configuration_missing", `${name} is required`);
  return value;
}

function safeAbsolute(value, name) {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) fail("path_invalid", `${name} must be an absolute path`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail("path_invalid", `${name} may not be a filesystem root`);
  return resolved;
}

function existingDirectory(value, name) {
  const resolved = safeAbsolute(value, name);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { fail("path_unavailable", `${name} is unavailable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("path_unsafe", `${name} must be a regular directory`);
  return resolved;
}

function existingRegularFile(value, name) {
  const resolved = safeAbsolute(value, name);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { fail("path_unavailable", `${name} is unavailable`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("path_unsafe", `${name} must be a regular file`);
  return resolved;
}

function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function commandConfiguration() {
  const configured = process.env.PRG32_BACKUP_CLI_BIN?.trim() || "prg32-store";
  const prefix = process.env.PRG32_BACKUP_CLI_ARGS ? JSON.parse(process.env.PRG32_BACKUP_CLI_ARGS) : [];
  if (!Array.isArray(prefix) || prefix.some((value) => typeof value !== "string")) fail("configuration_invalid", "PRG32_BACKUP_CLI_ARGS must be a JSON string array");
  if (configured.endsWith(".js")) {
    const executable = existingRegularFile(configured, "PRG32_BACKUP_CLI_BIN");
    return { command: process.execPath, prefix: [...prefix, executable], backend: executable.endsWith("backup-v4-cli.js") };
  }
  return { command: configured, prefix, backend: configured.endsWith("backup-v4-cli") };
}

function snapshotMode() {
  const value = process.env.PRG32_BACKUP_SNAPSHOT_MODE?.trim() || "exclusive";
  if (value !== "exclusive" && value !== "online") fail("configuration_invalid", "PRG32_BACKUP_SNAPSHOT_MODE must be exclusive or online");
  return value;
}

function invocation(operation, values) {
  const config = commandConfiguration();
  const command = config.backend ? (operation === "create" ? "backup" : operation) : "backup";
  const args = config.backend
    ? [command, ...values, ...(operation === "create" ? [`--${snapshotMode()}`] : [])]
    : ["--json", command, operation, ...values];
  return { command: config.command, args: [...config.prefix, ...args] };
}

function parseJsonOutput(output) {
  const lines = `${output.stdout || ""}\n${output.stderr || ""}`.trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* the wrapped CLI may emit human-readable diagnostics before JSON */ }
  }
  return undefined;
}

async function invoke(operation, values) {
  const call = invocation(operation, values);
  try {
    const result = await execFileAsync(call.command, call.args, { env: process.env, maxBuffer: 2 * 1024 * 1024 });
    const parsed = parseJsonOutput(result);
    if (!parsed) fail("backup_cli_invalid_output", "backup CLI returned no structured result");
    return parsed;
  } catch (caught) {
    const parsed = parseJsonOutput(caught);
    const code = parsed?.error?.code || parsed?.code || "backup_cli_failed";
    fail(String(code), "backup CLI operation failed");
  }
}

function sourceAndDestination() {
  return {
    source: existingDirectory(requiredEnv("PRG32_BACKUP_SOURCE"), "PRG32_BACKUP_SOURCE"),
    destination: existingDirectory(requiredEnv("PRG32_BACKUP_DESTINATION"), "PRG32_BACKUP_DESTINATION"),
    registry: existingRegularFile(requiredEnv("PRG32_BACKUP_KEY_REGISTRY"), "PRG32_BACKUP_KEY_REGISTRY"),
    authorization: requiredEnv("PRG32_BACKUP_AUTHORIZATION")
  };
}

function lockPath(destination) { return path.join(destination, ".prg32-backup.lock"); }

function acquireLock(destination) {
  const file = lockPath(destination);
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + "\n");
    fs.closeSync(fd);
    return file;
  } catch { fail("backup_lock_busy", "another backup operation is active"); }
}

function releaseLock(file) { try { fs.unlinkSync(file); } catch { /* cleanup is best effort */ } }

function archiveDirectory(archive) {
  const configured = process.env.PRG32_BACKUP_DESTINATION?.trim();
  const directory = existingDirectory(configured || path.dirname(archive), "PRG32_BACKUP_DESTINATION");
  if (!inside(archive, directory)) fail("archive_path_unsafe", "archive must be inside the backup destination");
  return directory;
}

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function archiveName() {
  const configured = process.env.PRG32_BACKUP_ARCHIVE_NAME?.trim();
  if (configured) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.backup4$/u.test(configured)) fail("archive_name_invalid", "PRG32_BACKUP_ARCHIVE_NAME is invalid");
    return configured;
  }
  return `prg32-${utcStamp()}-${crypto.randomUUID()}.backup4`;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}

function markerPath(archive, suffix) { return `${archive}${suffix}`; }

function writeJsonExclusive(filePath, value) {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

async function createBackup() {
  const { source, destination, registry, authorization } = sourceAndDestination();
  const lock = acquireLock(destination);
  const incoming = path.join(destination, ".incoming");
  fs.mkdirSync(incoming, { recursive: true, mode: 0o700 });
  const finalName = archiveName();
  const finalArchive = path.join(destination, finalName);
  const temporaryArchive = path.join(incoming, `.${finalName}.${process.pid}.partial`);
  const finalComplete = markerPath(finalArchive, COMPLETION_SUFFIX);
  try {
    if (fs.existsSync(finalArchive) || fs.existsSync(finalComplete)) fail("archive_exists", "refusing to overwrite an existing backup");
    if (process.env.PRG32_BACKUP_DRY_RUN === "1") {
      return { command: "create", dry_run: true, source, destination, archive: finalArchive, registry, authorization_required: true };
    }
    const result = await invoke("create", ["--source", source, "--output", temporaryArchive, "--key-registry", registry, "--authorization", authorization]);
    const verified = await invoke("verify", ["--archive", temporaryArchive, "--key-registry", registry]);
    const checksum = await sha256File(temporaryArchive);
    fs.renameSync(temporaryArchive, finalArchive);
    const temporaryComplete = markerPath(temporaryArchive, COMPLETION_SUFFIX);
    if (fs.existsSync(temporaryComplete)) fs.renameSync(temporaryComplete, finalComplete);
    else writeJsonExclusive(finalComplete, { verification_state: "complete", archive_sha256: checksum.sha256, archive_bytes: checksum.bytes });
    const verifiedPath = markerPath(finalArchive, VERIFIED_SUFFIX);
    writeJsonExclusive(verifiedPath, { verification_state: "complete", archive_sha256: checksum.sha256, archive_bytes: checksum.bytes, verified_at: new Date().toISOString() });
    return { command: "create", dry_run: false, archive: finalArchive, archive_bytes: checksum.bytes, archive_sha256: checksum.sha256, backup_id: result.backup_id || verified.backup_id, verification_state: "complete", transferred: false };
  } finally {
    for (const entry of fs.readdirSync(incoming)) {
      if (!entry.startsWith(`.${finalName}.`)) continue;
      const partialPath = path.join(incoming, entry);
      try {
        const partialStat = fs.lstatSync(partialPath);
        if (partialStat.isFile()) fs.unlinkSync(partialPath);
      } catch { /* an incomplete marker is never promoted and remains fail-closed */ }
    }
    releaseLock(lock);
  }
}

function parseArchiveTimestamp(name, stat) {
  const match = /^prg32-(\d{8}T\d{6}Z)-/u.exec(name);
  if (!match) return stat.mtime;
  const value = match[1];
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.valueOf()) ? stat.mtime : parsed;
}

function isoWeekKey(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function markerEvidence(archive, suffix, requiredFields = []) {
  const filePath = markerPath(archive, suffix);
  if (!fs.existsSync(filePath)) return { present: false, valid: false, value: undefined, anomaly: undefined };
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { return { present: true, valid: false, value: undefined, anomaly: "marker_unavailable" }; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { present: true, valid: false, value: undefined, anomaly: "marker_unsafe" };
  if (stat.size > 16 * 1024) return { present: true, valid: false, value: undefined, anomaly: "marker_too_large" };
  let value;
  try { value = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return { present: true, valid: false, value: undefined, anomaly: "marker_invalid_json" }; }
  if (!value || typeof value !== "object" || Array.isArray(value) || requiredFields.some((field) => !(field in value))) {
    return { present: true, valid: false, value, anomaly: "marker_invalid_shape" };
  }
  return { present: true, valid: true, value, anomaly: undefined };
}

function validArchiveMetadata(value, expectedBytes) {
  return value?.abi === BACKUP_V4_ABI
    && SAFE_BACKUP_ID.test(String(value.backup_id || ""))
    && SHA256.test(String(value.archive_sha256 || ""))
    && Number.isSafeInteger(value.archive_bytes)
    && value.archive_bytes > 0
    && value.archive_bytes === expectedBytes;
}

function retentionRecord(directory, entry, anomalies) {
  const archive = path.join(directory, entry.name);
  const stat = fs.lstatSync(archive);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    anomalies.push({ code: "archive_unsafe", name: entry.name });
    return undefined;
  }
  const completeMarker = markerEvidence(archive, COMPLETION_SUFFIX, ["abi", "archive_bytes", "archive_sha256", "backup_id"]);
  const verifiedMarker = markerEvidence(archive, VERIFIED_SUFFIX, ["verification_state", "archive_bytes", "archive_sha256"]);
  const transferredMarker = markerEvidence(archive, TRANSFERRED_SUFFIX, ["archive_sha256", "transferred_at", "transfer_status"]);
  for (const evidence of [completeMarker, verifiedMarker, transferredMarker]) if (evidence.anomaly) anomalies.push({ code: evidence.anomaly, name: entry.name });
  const complete = completeMarker.valid && validArchiveMetadata(completeMarker.value, stat.size);
  const verified = complete && verifiedMarker.valid && verifiedMarker.value.verification_state === "complete"
    && verifiedMarker.value.archive_bytes === stat.size
    && verifiedMarker.value.archive_sha256 === completeMarker.value.archive_sha256;
  const transferred = verified && transferredMarker.valid
    && transferredMarker.value.transfer_status === "operator_confirmed"
    && transferredMarker.value.archive_sha256 === completeMarker.value.archive_sha256;
  return {
    name: entry.name,
    archive,
    timestamp: parseArchiveTimestamp(entry.name, stat),
    complete,
    verified,
    transferred,
    backupId: completeMarker.value?.backup_id,
    archiveSha256: completeMarker.value?.archive_sha256,
    archiveBytes: stat.size
  };
}

function selectNewestPerBucket(records, bucket, limit) {
  const selected = new Set();
  const buckets = new Map();
  for (const record of records) {
    const key = bucket(record.timestamp);
    if (!buckets.has(key)) buckets.set(key, record);
  }
  [...buckets.entries()].sort((a, b) => b[1].timestamp - a[1].timestamp).slice(0, limit).forEach(([, record]) => selected.add(record.name));
  return selected;
}

export function selectRetention(records, policy = { daily: 7, weekly: 4, monthly: 3 }) {
  const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp || a.name.localeCompare(b.name));
  const valid = sorted.filter((record) => record.complete && record.verified);
  const protectedNames = new Set();
  if (valid[0]) protectedNames.add(valid[0].name);
  if (sorted.find((record) => record.verified)) protectedNames.add(sorted.find((record) => record.verified).name);
  for (const record of sorted) if (!record.transferred || !record.verified || !record.complete) protectedNames.add(record.name);
  for (const name of selectNewestPerBucket(sorted, (date) => date.toISOString().slice(0, 10), policy.daily)) protectedNames.add(name);
  for (const name of selectNewestPerBucket(sorted, isoWeekKey, policy.weekly)) protectedNames.add(name);
  for (const name of selectNewestPerBucket(sorted, (date) => date.toISOString().slice(0, 7), policy.monthly)) protectedNames.add(name);
  const candidates = sorted.filter((record) => record.complete && record.verified && record.transferred && !protectedNames.has(record.name)).map((record) => record.name);
  return { protected: [...protectedNames].sort(), candidates };
}

function retentionInventory(directory) {
  const records = [];
  const anomalies = [];
  const backupIds = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(BACKUP_SUFFIX)) continue;
    if (!validateArchiveName(entry.name)) {
      anomalies.push({ code: "archive_name_invalid", name: entry.name });
      continue;
    }
    const record = retentionRecord(directory, entry, anomalies);
    if (!record) continue;
    if (record.backupId) {
      const duplicate = backupIds.get(record.backupId);
      if (duplicate) anomalies.push({ code: "duplicate_archive_identifier", name: record.name, duplicate_of: duplicate });
      else backupIds.set(record.backupId, record.name);
    }
    records.push(record);
  }
  return { records, anomalies };
}

function recordsFromDirectory(directory) {
  return retentionInventory(directory).records;
}

function schedulerStatus(directory) {
  const configured = process.env.PRG32_BACKUP_SCHEDULER_STATE_FILE?.trim() || path.join(directory, ".prg32-scheduler-state.json");
  if (!path.isAbsolute(configured) || configured.includes("\0")) {
    return { configured: false, running: false, status: "unavailable", retention_enabled: false, last_success_at: null, next_scheduled_at: null, last_retention_evaluation_at: null, last_retention_success_at: null, last_retention_failure_code: null, last_retention_deleted_count: 0, last_retention_retained_count: 0 };
  }
  const stateFile = path.resolve(configured);
  if (!inside(stateFile, directory)) {
    return { configured: false, running: false, status: "unavailable", retention_enabled: false, last_success_at: null, next_scheduled_at: null, last_retention_evaluation_at: null, last_retention_success_at: null, last_retention_failure_code: null, last_retention_deleted_count: 0, last_retention_retained_count: 0 };
  }
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {
    return { configured: false, running: false, status: "not_observed", retention_enabled: false, last_success_at: null, next_scheduled_at: null, last_retention_evaluation_at: null, last_retention_success_at: null, last_retention_failure_code: null, last_retention_deleted_count: 0, last_retention_retained_count: 0 };
  }
  const running = state?.status === "idle" || state?.status === "running";
  return {
    configured: true,
    running,
    status: typeof state?.status === "string" ? state.status : "invalid",
    retention_enabled: state?.retention_enabled === true,
    last_success_at: state?.last_success_at || null,
    next_scheduled_at: state?.next_scheduled_at || null,
    last_retention_evaluation_at: state?.last_retention_evaluation_at || null,
    last_retention_success_at: state?.last_retention_success_at || null,
    last_retention_failure_code: state?.last_retention_failure_code || null,
    last_retention_deleted_count: Number(state?.last_retention_deleted_count || 0),
    last_retention_retained_count: Number(state?.last_retention_retained_count || 0)
  };
}

function status() {
  const directory = existingDirectory(process.env.PRG32_BACKUP_DESTINATION || requiredEnv("PRG32_BACKUP_DIRECTORY"), "PRG32_BACKUP_DESTINATION");
  const inventory = retentionInventory(directory);
  const records = inventory.records.sort((a, b) => b.timestamp - a.timestamp || a.name.localeCompare(b.name));
  const latest = records[0];
  const latestVerified = records.find((record) => record.complete && record.verified);
  const policy = { daily: Number(process.env.PRG32_BACKUP_KEEP_DAILY || 7), weekly: Number(process.env.PRG32_BACKUP_KEEP_WEEKLY || 4), monthly: Number(process.env.PRG32_BACKUP_KEEP_MONTHLY || 3) };
  const selection = selectRetention(records, policy);
  const lastBackupAt = latest?.timestamp.toISOString();
  const scheduler = schedulerStatus(directory);
  return {
    command: "status",
    archive_count: records.length,
    last_local_backup: latest?.name || null,
    last_local_backup_at: lastBackupAt || null,
    backup_age_seconds: lastBackupAt ? Math.max(0, Math.floor((Date.now() - new Date(lastBackupAt).valueOf()) / 1000)) : null,
    last_verification: latestVerified ? { archive: latestVerified.name, result: "verified", verified_marker: true } : { archive: null, result: "not_recorded", verified_marker: false },
    retention_dry_run: { policy, protected: selection.protected, candidates: selection.candidates, anomalies: inventory.anomalies },
    scheduling_configured: scheduler.configured,
    scheduler_running: scheduler.running,
    scheduler_status: scheduler.status,
    retention_enabled: scheduler.retention_enabled,
    last_retention_evaluation_at: scheduler.last_retention_evaluation_at,
    last_retention_success_at: scheduler.last_retention_success_at,
    last_retention_failure_code: scheduler.last_retention_failure_code,
    last_retention_deleted_count: scheduler.last_retention_deleted_count,
    last_retention_retained_count: scheduler.last_retention_retained_count,
    scheduler_last_success_at: scheduler.last_success_at,
    scheduler_next_scheduled_at: scheduler.next_scheduled_at,
    external_custody_verified: false,
    external_custody_status: "not_verified"
  };
}

async function verifyBackup() {
  const archive = existingRegularFile(requiredEnv("PRG32_BACKUP_ARCHIVE"), "PRG32_BACKUP_ARCHIVE");
  const registry = existingRegularFile(requiredEnv("PRG32_BACKUP_KEY_REGISTRY"), "PRG32_BACKUP_KEY_REGISTRY");
  const lock = acquireLock(archiveDirectory(archive));
  try {
    const result = await invoke("verify", ["--archive", archive, "--key-registry", registry]);
    const checksum = await sha256File(archive);
    return { command: "verify", archive, archive_bytes: checksum.bytes, archive_sha256: checksum.sha256, backup_id: result.backup_id, verification_state: result.verification_state || "complete" };
  } finally { releaseLock(lock); }
}

async function restoreBackup() {
  const archive = existingRegularFile(requiredEnv("PRG32_BACKUP_ARCHIVE"), "PRG32_BACKUP_ARCHIVE");
  const target = safeAbsolute(requiredEnv("PRG32_BACKUP_RESTORE_TARGET"), "PRG32_BACKUP_RESTORE_TARGET");
  const registry = existingRegularFile(requiredEnv("PRG32_BACKUP_KEY_REGISTRY"), "PRG32_BACKUP_KEY_REGISTRY");
  const authorization = requiredEnv("PRG32_BACKUP_AUTHORIZATION");
  const lock = acquireLock(archiveDirectory(archive));
  try {
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(target).length) fail("restore_target_conflict", "restore target must be a new empty directory");
    } else fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return { command: "restore", archive, target, ...(await invoke("restore", ["--yes", "--archive", archive, "--target", target, "--key-registry", registry, "--authorization", authorization])) };
  } finally { releaseLock(lock); }
}

async function markTransferred() {
  const archive = existingRegularFile(requiredEnv("PRG32_BACKUP_ARCHIVE"), "PRG32_BACKUP_ARCHIVE");
  const expected = requiredEnv("PRG32_BACKUP_EXPECTED_SHA256").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected)) fail("checksum_invalid", "PRG32_BACKUP_EXPECTED_SHA256 must be a SHA-256 digest");
  const lock = acquireLock(archiveDirectory(archive));
  try {
    const actual = (await sha256File(archive)).sha256;
    if (actual !== expected) fail("checksum_mismatch", "backup checksum does not match transfer evidence");
    const marker = markerPath(archive, TRANSFERRED_SUFFIX);
    if (fs.existsSync(marker)) fail("transfer_marker_exists", "refusing to overwrite transfer evidence");
    writeJsonExclusive(marker, { archive_sha256: actual, transferred_at: new Date().toISOString(), transfer_status: "operator_confirmed" });
    return { command: "mark-transferred", archive, archive_sha256: actual, transfer_status: "operator_confirmed" };
  } finally { releaseLock(lock); }
}

function retentionPolicy() {
  const policy = { daily: Number(process.env.PRG32_BACKUP_KEEP_DAILY || 7), weekly: Number(process.env.PRG32_BACKUP_KEEP_WEEKLY || 4), monthly: Number(process.env.PRG32_BACKUP_KEEP_MONTHLY || 3) };
  if (Object.values(policy).some((value) => !Number.isInteger(value) || value < 0)) fail("retention_policy_invalid", "retention windows must be non-negative integers");
  return policy;
}

async function validateDeletionCandidate(directory, record) {
  if (!validateArchiveName(record.name) || !inside(path.join(directory, record.name), directory)) fail("retention_candidate_unsafe", "retention candidate path is unsafe");
  const current = fs.lstatSync(record.archive);
  if (current.isSymbolicLink() || !current.isFile() || current.size !== record.archiveBytes) fail("retention_candidate_changed", "retention candidate changed during validation");
  const actual = await sha256File(record.archive);
  if (actual.sha256 !== record.archiveSha256 || actual.bytes !== record.archiveBytes) fail("retention_candidate_checksum_mismatch", "retention candidate checksum does not match completion metadata");
  for (const suffix of [COMPLETION_SUFFIX, VERIFIED_SUFFIX, TRANSFERRED_SUFFIX]) {
    const marker = path.join(directory, `${record.name}${suffix}`);
    const markerStat = fs.lstatSync(marker);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) fail("retention_candidate_marker_unsafe", "retention candidate marker is unsafe");
  }
}

export async function performRetention({ directory, apply = false, requiredArchive, policy = retentionPolicy() } = {}) {
  const resolvedDirectory = existingDirectory(directory, "PRG32_BACKUP_DESTINATION");
  const lock = acquireLock(resolvedDirectory);
  try {
    const inventory = retentionInventory(resolvedDirectory);
    const records = inventory.records.sort((a, b) => b.timestamp - a.timestamp || a.name.localeCompare(b.name));
    const selection = selectRetention(records, policy);
    const candidates = selection.candidates;
    const retained = records.filter((record) => !candidates.includes(record.name));
    if (requiredArchive && candidates.includes(path.basename(requiredArchive))) fail("retention_required_archive_candidate", "the newly created backup must remain retained");
    if (apply && inventory.anomalies.length > 0) fail("retention_inventory_inconsistent", "backup destination contains unsafe or malformed archive metadata");
    if (apply && candidates.length > 0) {
      if (!retained.some((record) => record.complete && record.verified)) fail("retention_no_recoverable_backup", "retention would delete the only independently verified backup");
      for (const name of candidates) await validateDeletionCandidate(resolvedDirectory, records.find((record) => record.name === name));
      for (const name of candidates) {
        const archive = path.join(resolvedDirectory, name);
        for (const suffix of ["", COMPLETION_SUFFIX, VERIFIED_SUFFIX, TRANSFERRED_SUFFIX]) fs.unlinkSync(`${archive}${suffix}`);
      }
    }
    return {
      command: "retention",
      dry_run: !apply,
      policy,
      protected: selection.protected,
      candidates,
      anomalies: inventory.anomalies,
      retained_count: retained.length,
      deleted: apply ? candidates : [],
      evaluated_at: new Date().toISOString()
    };
  } finally { releaseLock(lock); }
}

async function retention() {
  const directory = process.env.PRG32_BACKUP_DESTINATION || requiredEnv("PRG32_BACKUP_DIRECTORY");
  const apply = process.argv.includes("--apply");
  if (apply && process.env.PRG32_BACKUP_RETENTION_CONFIRM !== RETENTION_CONFIRMATION) fail("retention_confirmation_required", "retention deletion requires explicit confirmation");
  return performRetention({ directory, apply, requiredArchive: process.env.PRG32_BACKUP_REQUIRED_ARCHIVE });
}

function print(result) { process.stdout.write(`${JSON.stringify(result)}\n`); }

async function main() {
  const command = process.argv[2] || "help";
  if (command === "help" || command === "--help") {
    print({ usage: "create|verify|restore|retention|mark-transferred|status", environment: "explicit PRG32_BACKUP_* paths and authorization are required" });
    return;
  }
  if (command === "create") print(await createBackup());
  else if (command === "verify") print(await verifyBackup());
  else if (command === "restore") print(await restoreBackup());
  else if (command === "mark-transferred") print(await markTransferred());
  else if (command === "retention") print(await retention());
  else if (command === "status") print(status());
  else fail("usage", "unsupported backup wrapper command");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: error?.code || "backup_wrapper_failed" } })}\n`);
    process.exitCode = 1;
  }
}
