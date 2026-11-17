#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RETENTION_CONFIRMATION } from "./prg32-backup.mjs";

export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MIN_INTERVAL_MS = 60 * 1000;

function fail(message) {
  const error = new Error(message);
  error.code = "scheduler_configuration_invalid";
  throw error;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function absoluteDirectory(name) {
  const value = required(name);
  if (!path.isAbsolute(value) || value.includes("\0")) fail(`${name} must be an absolute path`);
  const resolved = path.resolve(value);
  let stats;
  try { stats = fs.lstatSync(resolved); } catch { fail(`${name} is unavailable`); }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`${name} must be a regular directory`);
  return resolved;
}

function absoluteFile(name) {
  const value = required(name);
  if (!path.isAbsolute(value) || value.includes("\0")) fail(`${name} must be an absolute path`);
  const resolved = path.resolve(value);
  let stats;
  try { stats = fs.lstatSync(resolved); } catch { fail(`${name} is unavailable`); }
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${name} must be a regular file`);
  return resolved;
}

function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function parseIntervalMs(value = process.env.PRG32_BACKUP_INTERVAL_MS) {
  const raw = value === undefined || value === "" ? String(DEFAULT_INTERVAL_MS) : String(value).trim();
  if (!/^\d+$/u.test(raw)) fail("PRG32_BACKUP_INTERVAL_MS must be an integer number of milliseconds");
  const interval = Number(raw);
  if (!Number.isSafeInteger(interval) || interval < MIN_INTERVAL_MS) fail(`PRG32_BACKUP_INTERVAL_MS must be at least ${MIN_INTERVAL_MS}`);
  return interval;
}

export function parseBoolean(value, name, fallback = false) {
  if (value === undefined || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  fail(`${name} must be true or false`);
}

export function parseRetentionEnabled(value = process.env.PRG32_BACKUP_RETENTION_ENABLED) {
  return parseBoolean(value, "PRG32_BACKUP_RETENTION_ENABLED", false);
}

export function parseSnapshotMode(value = process.env.PRG32_BACKUP_SNAPSHOT_MODE) {
  const mode = value === undefined || value === "" ? "exclusive" : String(value).trim();
  if (mode !== "exclusive" && mode !== "online") fail("PRG32_BACKUP_SNAPSHOT_MODE must be exclusive or online");
  return mode;
}

export function validateTimezone(value = process.env.PRG32_BACKUP_TIMEZONE) {
  const timezone = (value || "UTC").trim();
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { fail("PRG32_BACKUP_TIMEZONE must be a valid IANA timezone"); }
  return timezone;
}

export function nextExecution(now, intervalMs) {
  return new Date(now.getTime() + intervalMs);
}

export function schedulerStateIsHealthy(state) {
  return state?.status !== "failed" && state?.status !== "stopped_with_failure";
}

function statePath(destination) {
  const configured = process.env.PRG32_BACKUP_SCHEDULER_STATE_FILE?.trim();
  if (!configured) return path.join(destination, ".prg32-scheduler-state.json");
  if (!path.isAbsolute(configured) || configured.includes("\0")) fail("PRG32_BACKUP_SCHEDULER_STATE_FILE must be an absolute path");
  const resolved = path.resolve(configured);
  if (!inside(resolved, destination)) fail("PRG32_BACKUP_SCHEDULER_STATE_FILE must be inside the backup destination");
  return resolved;
}

function writeState(filePath, state) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readState(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return undefined; }
}

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ component: "backup-scheduler", event, ...fields })}\n`);
}

function errorCode(stderr) {
  for (const line of String(stderr || "").trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line);
      if (value?.error?.code) return String(value.error.code);
    } catch { /* the wrapper's structured line may not be the first line */ }
  }
  return "backup_execution_failed";
}

function configuration() {
  const source = absoluteDirectory("PRG32_BACKUP_SOURCE");
  const destination = absoluteDirectory("PRG32_BACKUP_DESTINATION");
  if (inside(destination, source)) fail("PRG32_BACKUP_DESTINATION must be outside the canonical source root");
  const wrapper = absoluteFile("PRG32_BACKUP_WRAPPER");
  const registry = absoluteFile("PRG32_BACKUP_KEY_REGISTRY");
  const intervalMs = parseIntervalMs();
  const timezone = validateTimezone(process.env.PRG32_BACKUP_TIMEZONE);
  const runOnStart = parseBoolean(process.env.PRG32_BACKUP_RUN_ON_START, "PRG32_BACKUP_RUN_ON_START");
  const retentionEnabled = parseRetentionEnabled();
  const snapshotMode = parseSnapshotMode();
  const authorization = required("PRG32_BACKUP_AUTHORIZATION");
  const stateFile = statePath(destination);
  return { source, destination, wrapper, registry, intervalMs, timezone, runOnStart, retentionEnabled, snapshotMode, authorization, stateFile };
}

function childEnvironment(config, operation, requiredArchive) {
  return {
    ...process.env,
    PRG32_BACKUP_SOURCE: config.source,
    PRG32_BACKUP_DESTINATION: config.destination,
    PRG32_BACKUP_WRAPPER: config.wrapper,
    PRG32_BACKUP_KEY_REGISTRY: config.registry,
    PRG32_BACKUP_SNAPSHOT_MODE: config.snapshotMode,
    PRG32_BACKUP_AUTHORIZATION: config.authorization,
    ...(operation === "retention" ? {
      PRG32_BACKUP_RETENTION_CONFIRM: RETENTION_CONFIRMATION,
      ...(requiredArchive ? { PRG32_BACKUP_REQUIRED_ARCHIVE: requiredArchive } : {})
    } : {})
  };
}

function parseChildOutput(output) {
  for (const line of String(output || "").trim().split("\n").reverse()) {
    try { const value = JSON.parse(line); if (value && typeof value === "object") return value; } catch { /* structured output is optional on failure */ }
  }
  return undefined;
}

function runChild(config, operation, requiredArchive) {
  return new Promise((resolve) => {
    const args = [config.wrapper, operation, ...(operation === "retention" ? ["--apply"] : [])];
    const child = spawn(process.execPath, args, {
      env: childEnvironment(config, operation, requiredArchive),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-8192); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
    child.on("error", () => resolve({ ok: false, code: "backup_process_start_failed" }));
    child.on("exit", (code, signal) => resolve(code === 0
      ? { ok: true, result: parseChildOutput(stdout) }
      : { ok: false, code: errorCode(stderr), signal: signal || undefined, result: parseChildOutput(stdout) }));
  });
}

async function runOnce(config, state) {
  if (state.active) return { ok: false, skipped: true, code: "backup_scheduler_overlap" };
  const startedAt = new Date().toISOString();
  state.active = true;
  state.status = "running";
  state.last_started_at = startedAt;
  writeState(config.stateFile, state);
  log("backup_started");
  const backup = await runChild(config, "create");
  state.active = false;
  state.last_finished_at = new Date().toISOString();
  if (!backup.ok) {
    state.status = "failed";
    state.last_failure_code = backup.code;
    writeState(config.stateFile, state);
    log("backup_failed", { code: backup.code });
    return backup;
  }
  state.last_backup_success_at = state.last_finished_at;
  state.last_verified_backup = typeof backup.result?.archive === "string" ? path.basename(backup.result.archive) : null;
  writeState(config.stateFile, state);
  log("backup_succeeded");
  if (config.retentionEnabled) {
    state.status = "retention";
    state.last_retention_evaluation_at = new Date().toISOString();
    writeState(config.stateFile, state);
    const retention = await runChild(config, "retention", state.last_verified_backup);
    if (!retention.ok) {
      state.status = "failed";
      state.last_failure_code = `retention_${retention.code}`;
      state.last_retention_failure_code = retention.code;
      writeState(config.stateFile, state);
      log("retention_failed", { code: retention.code });
      return { ok: false, code: `retention_${retention.code}` };
    }
    state.last_retention_success_at = new Date().toISOString();
    state.last_retention_failure_code = null;
    state.last_retention_deleted_count = Array.isArray(retention.result?.deleted) ? retention.result.deleted.length : 0;
    state.last_retention_retained_count = Number(retention.result?.retained_count || 0);
    log("retention_succeeded", { deleted: state.last_retention_deleted_count, retained: state.last_retention_retained_count });
  }
  state.status = "idle";
  state.last_success_at = new Date().toISOString();
  state.last_failure_code = null;
  writeState(config.stateFile, state);
  return backup;
}

function healthcheck() {
  const destination = absoluteDirectory("PRG32_BACKUP_DESTINATION");
  const stateFile = statePath(destination);
  const state = readState(stateFile);
  if (!state || !schedulerStateIsHealthy(state)) process.exitCode = 1;
}

async function main() {
  if (process.argv.includes("--healthcheck")) { healthcheck(); return; }
  const config = configuration();
  const state = {
    schema: "prg32-backup-scheduler-1.0",
    status: "idle",
    active: false,
    interval_ms: config.intervalMs,
    timezone: config.timezone,
    next_scheduled_at: null,
    last_started_at: null,
    last_finished_at: null,
    last_success_at: null,
    last_failure_code: null,
    retention_enabled: config.retentionEnabled,
    last_backup_success_at: null,
    last_verified_backup: null,
    last_retention_evaluation_at: null,
    last_retention_success_at: null,
    last_retention_failure_code: null,
    last_retention_deleted_count: 0,
    last_retention_retained_count: 0
  };
  const previous = readState(config.stateFile);
  if (previous) {
    state.last_started_at = previous.last_started_at || null;
    state.last_finished_at = previous.last_finished_at || null;
    state.last_success_at = previous.last_success_at || null;
    state.next_scheduled_at = previous.next_scheduled_at || null;
    state.last_backup_success_at = previous.last_backup_success_at || null;
    state.last_verified_backup = previous.last_verified_backup || null;
    state.last_retention_evaluation_at = previous.last_retention_evaluation_at || null;
    state.last_retention_success_at = previous.last_retention_success_at || null;
    state.last_retention_failure_code = previous.last_retention_failure_code || null;
    state.last_retention_deleted_count = previous.last_retention_deleted_count || 0;
    state.last_retention_retained_count = previous.last_retention_retained_count || 0;
  }
  if (previous && !schedulerStateIsHealthy(previous)) {
    state.status = "failed";
    state.last_failure_code = previous.last_failure_code || "backup_execution_failed";
  }
  writeState(config.stateFile, state);
  log("started", { interval_ms: config.intervalMs, timezone: config.timezone, snapshot_mode: config.snapshotMode, run_on_start: config.runOnStart });

  let stopping = false;
  let timer;
  let activeRun;
  const schedule = () => {
    const when = nextExecution(new Date(), config.intervalMs);
    state.next_scheduled_at = when.toISOString();
    writeState(config.stateFile, state);
    timer = setTimeout(async () => {
      activeRun = runOnce(config, state);
      await activeRun;
      activeRun = undefined;
      if (!stopping) schedule();
    }, config.intervalMs);
  };

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (activeRun) await activeRun;
    state.status = state.last_failure_code ? "stopped_with_failure" : "stopped";
    state.active = false;
    writeState(config.stateFile, state);
    log("stopped", { signal });
  };
  process.once("SIGTERM", () => { void stop("SIGTERM").then(() => process.exit(0)); });
  process.once("SIGINT", () => { void stop("SIGINT").then(() => process.exit(0)); });

  if (process.argv.includes("--once") || config.runOnStart) {
    activeRun = runOnce(config, state);
    const result = await activeRun;
    activeRun = undefined;
    if (process.argv.includes("--once")) {
      state.status = result.ok ? "stopped" : "stopped_with_failure";
      writeState(config.stateFile, state);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
  }
  schedule();
  await new Promise(() => {});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { log("configuration_failed", { code: error?.code || "scheduler_failed" }); process.exitCode = 1; }
}
