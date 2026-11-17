#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  PROFILES,
  SECRET_KEYS,
  SERVICE_NAMES,
  ManagementError,
  commandHelp,
  fail,
  parseArgs,
  parseCommandArgs
} from "./manage/core.mjs";
import { createBackupCommand } from "./manage/backup.mjs";
import { createHealthCommand } from "./manage/health.mjs";
import { createDeployCommand } from "./manage/deploy.mjs";
import { createVerificationCommands } from "./manage/verification.mjs";
import {
  createManagementRuntime,
  normalizeComposeServices,
  parseJsonLines,
} from "./manage/runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "m5.5.4";
const STANDALONE_SECRET_FILES = Object.freeze([
  "canonical-read-authorization",
  "canonical-write-authorization",
  "session-secret",
  "bootstrap-token",
]);

function readEnvFile(filePath) {
  if (!filePath) return {};
  const resolved = safePath(filePath, "environment file");
  const stat = regularStat(resolved, "environment file");
  if ((stat.mode & 0o077) !== 0) fail("env_file_permissions", "environment file must not be group/world-readable", EXIT.CONFIG);
  const values = {};
  for (const rawLine of fs.readFileSync(resolved, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) fail("env_file_invalid", "environment file contains an invalid assignment", EXIT.CONFIG);
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function safePath(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("path_invalid", `${name} is invalid`, EXIT.CONFIG);
  return path.resolve(value);
}

function regularStat(value, name) {
  let stat;
  try { stat = fs.lstatSync(value); } catch { fail("path_unavailable", `${name} is unavailable`, EXIT.CONFIG); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("path_unsafe", `${name} must be a regular file`, EXIT.CONFIG);
  return stat;
}

function directoryStat(value, name, { allowMissing = false } = {}) {
  const resolved = safePath(value, name);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch {
    if (allowMissing) return { missing: true, path: resolved };
    fail("path_unavailable", `${name} is unavailable`, EXIT.CONFIG);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("path_unsafe", `${name} must be a regular directory`, EXIT.CONFIG);
  return { missing: false, path: resolved, stat };
}

function mergedEnvironment(fileEnv) {
  return { ...fileEnv, ...process.env };
}

function context(parsed) {
  if (!Object.hasOwn(PROFILES, parsed.globals.profile)) fail("profile_invalid", `unsupported profile: ${parsed.globals.profile}`, EXIT.USAGE);
  const profile = PROFILES[parsed.globals.profile];
  const envFile = readEnvFile(parsed.globals.envFile);
  const env = mergedEnvironment(envFile);
  return { ...parsed, profileName: parsed.globals.profile, profile, envFile, env, composeFile: path.join(ROOT, profile.compose), project: profile.project };
}

function value(ctx, name) { return typeof ctx.env[name] === "string" && ctx.env[name].trim() ? ctx.env[name].trim() : undefined; }

function secretValue(ctx, name) {
  const current = value(ctx, name);
  if (current && current.length > 2) return current;
  return undefined;
}

function redact(ctx, text) {
  let output = String(text ?? "");
  for (const key of SECRET_KEYS) {
    const secret = secretValue(ctx, key);
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

const {
  composeArgs,
  composeServices,
  requireDocker,
  runCompose,
  runFile,
  servicesSummary,
} = createManagementRuntime({ root: ROOT, redact, safePath });

function ensureNode24() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 24) fail("node_version", `Node.js 24 is required; found ${process.version}`, EXIT.DEPENDENCY);
}

function profileRequiresExplicitMutation(ctx) {
  if (ctx.profileName !== "standalone" && !ctx.globals.explicitProfile) fail("profile_confirmation_required", `--profile ${ctx.profileName} is required for non-standalone mutations`, EXIT.USAGE);
}

function configValues(ctx) {
  if (ctx.profileName === "standalone") return {
    data: value(ctx, "PRG32_DATA_DIR"),
    keyRegistry: value(ctx, "PRG32_KEY_REGISTRY_FILE"),
    secretDirectory: value(ctx, "PRG32_SECRET_DIR"),
    backupDestination: value(ctx, "PRG32_BACKUP_DESTINATION_DIR")
  };
  if (ctx.profileName === "candidate") return {
    data: value(ctx, "PRG32_CANDIDATE_DATA_DIR") ?? path.join(ROOT, ".local", "candidate", "canonical"),
    keyRegistry: value(ctx, "PRG32_CANDIDATE_KEY_REGISTRY_FILE"),
    backupDestination: value(ctx, "PRG32_CANDIDATE_BACKUP_DESTINATION_DIR")
  };
  return {
    data: value(ctx, "PRG32_OPERATIONAL_DATA_DIR"),
    keyRegistry: value(ctx, "PRG32_OPERATIONAL_KEY_REGISTRY_FILE"),
    secretDirectory: value(ctx, "PRG32_OPERATIONAL_SECRET_DIR"),
    backupDestination: value(ctx, "PRG32_OPERATIONAL_BACKUP_DESTINATION_DIR")
  };
}

function requiredConfigNames(ctx) {
  if (ctx.profileName === "standalone") return [
    "PRG32_DATA_DIR",
    "PRG32_KEY_REGISTRY_FILE",
    "PRG32_SECRET_DIR",
    "PRG32_TRUST_PROXY",
    "PRG32_FRONTEND_PUBLIC_ORIGIN",
    "PRG32_API_PUBLIC_ORIGIN",
    "PRG32_WS_PUBLIC_URL"
  ];
  if (ctx.profileName === "operational") return [
    "PRG32_OPERATIONAL_DATA_DIR",
    "PRG32_OPERATIONAL_KEY_REGISTRY_FILE",
    "PRG32_OPERATIONAL_SECRET_DIR",
    "PRG32_OPERATIONAL_EMAIL_FROM"
  ];
  return [];
}

function inspectConfig(ctx, { allowMissingData = false, requireBackup = false } = {}) {
  const checks = [];
  for (const name of requiredConfigNames(ctx)) checks.push({ name: `config:${name}`, status: value(ctx, name) ? "PASS" : "FAIL", detail: value(ctx, name) ? "configured" : "required value is missing" });
  const configured = configValues(ctx);
  if (configured.data) {
    const data = directoryStat(configured.data, "data directory", { allowMissing: allowMissingData });
    checks.push({ name: "data-directory", status: data.missing ? "WARN" : "PASS", detail: data.missing ? "will be created by install" : "regular directory" });
  } else checks.push({ name: "data-directory", status: "FAIL", detail: "data directory is not configured" });
  if (configured.keyRegistry) {
    try {
      const stat = regularStat(safePath(configured.keyRegistry, "key registry"), "key registry");
      checks.push({ name: "key-registry", status: (stat.mode & 0o077) === 0 ? "PASS" : "FAIL", detail: (stat.mode & 0o077) === 0 ? "protected regular file" : "group/world-readable" });
    } catch (error) { checks.push({ name: "key-registry", status: "FAIL", detail: error.message }); }
  } else if (ctx.profileName !== "candidate") checks.push({ name: "key-registry", status: "FAIL", detail: "key registry is not configured" });
  if (ctx.profileName === "standalone" || ctx.profileName === "operational") {
    if (!configured.secretDirectory) {
      checks.push({ name: "secret-directory", status: "FAIL", detail: "PRG32_SECRET_DIR is not configured" });
    } else {
      try {
        directoryStat(configured.secretDirectory, "secret directory");
        checks.push({ name: "secret-directory", status: "PASS", detail: "regular directory" });
        for (const fileName of STANDALONE_SECRET_FILES) {
          const filePath = path.join(configured.secretDirectory, fileName);
          const stat = regularStat(filePath, `secret file ${fileName}`);
          checks.push({
            name: `secret:${fileName}`,
            status: (stat.mode & 0o077) === 0 ? "PASS" : "FAIL",
            detail: (stat.mode & 0o077) === 0 ? "protected regular file" : "group/world-readable",
          });
        }
      } catch (error) {
        checks.push({ name: "secret-files", status: "FAIL", detail: error.message });
      }
    }
  }
  if (requireBackup) {
    if (!configured.backupDestination) checks.push({ name: "backup-destination", status: "FAIL", detail: "PRG32_BACKUP_DESTINATION_DIR is required for host backup commands" });
    else {
      try { const backup = directoryStat(configured.backupDestination, "backup destination"); checks.push({ name: "backup-destination", status: "PASS", detail: "regular directory" }); }
      catch (error) { checks.push({ name: "backup-destination", status: "FAIL", detail: error.message }); }
    }
  }
  return { checks, ok: checks.every((item) => item.status !== "FAIL") };
}

async function composeConfigCheck(ctx, { synthetic = false, scheduler = false } = {}) {
  await requireDocker(ctx);
  const temp = synthetic ? fs.mkdtempSync(path.join(os.tmpdir(), "prg32-manage-ci-")) : undefined;
  let keyFile;
  try {
    const env = { ...process.env };
    if (synthetic) {
      keyFile = path.join(temp, "key-registry.json");
      fs.writeFileSync(keyFile, "{}\n", { mode: 0o600 });
      const syntheticPaths = {
        data: path.join(temp, "data"),
        backup: path.join(temp, "backups"),
        secretDirectory: path.join(temp, "secrets"),
      };
      fs.mkdirSync(syntheticPaths.data, { recursive: true, mode: 0o700 });
      fs.mkdirSync(syntheticPaths.backup, { recursive: true, mode: 0o700 });
      fs.mkdirSync(syntheticPaths.secretDirectory, { recursive: true, mode: 0o700 });
      for (const fileName of STANDALONE_SECRET_FILES) {
        fs.writeFileSync(
          path.join(syntheticPaths.secretDirectory, fileName),
          "synthetic-secret-value-012345678901234567890123\n",
          { mode: 0o600 },
        );
      }
      Object.assign(env, {
        PRG32_DATA_DIR: syntheticPaths.data,
        PRG32_KEY_REGISTRY_FILE: keyFile,
        PRG32_SECRET_DIR: syntheticPaths.secretDirectory,
        PRG32_BACKUP_DESTINATION_DIR: syntheticPaths.backup,
        PRG32_TRUST_PROXY: "false",
        PRG32_FRONTEND_PUBLIC_ORIGIN: "https://store.example.invalid",
        PRG32_API_PUBLIC_ORIGIN: "https://api.example.invalid",
        PRG32_WS_PUBLIC_URL: "wss://api.example.invalid/api/multiplayer",
        PRG32_OPERATIONAL_DATA_DIR: syntheticPaths.data,
        PRG32_OPERATIONAL_KEY_REGISTRY_FILE: keyFile,
        PRG32_OPERATIONAL_SECRET_DIR: syntheticPaths.secretDirectory,
        PRG32_OPERATIONAL_EMAIL_FROM: "noreply@example.invalid",
        PRG32_OPERATIONAL_BACKUP_DESTINATION_DIR: syntheticPaths.backup,
        PRG32_CANDIDATE_DATA_DIR: syntheticPaths.data
      });
    }
    const result = await runFile("docker", composeArgs(ctx, ["config", "--quiet"], { scheduler, envFile: !synthetic }), { ...ctx, globals: { ...ctx.globals }, env: env }, { env });
    return { ok: true, stdout: result.stdout, detail: "compose configuration accepted" };
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}

function managementLockPath(ctx) {
  const configured = value(ctx, "PRG32_MANAGE_STATE_DIR") ?? path.join(ROOT, ".local", "management");
  const dir = safePath(configured, "management state directory");
  if (dir === path.parse(dir).root) fail("path_invalid", "management state directory may not be a filesystem root", EXIT.CONFIG);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `.${ctx.profileName}.lock`);
}

async function withManagementLock(ctx, operation, callback) {
  const lockPath = managementLockPath(ctx);
  let fd;
  try { fd = fs.openSync(lockPath, "wx", 0o600); }
  catch { fail("management_lock_busy", "another management operation is active; inspect the lock before retrying", EXIT.FAILED); }
  try {
    fs.writeSync(fd, `${JSON.stringify({ operation, pid: process.pid, started_at: new Date().toISOString() })}\n`);
    fs.fsyncSync(fd);
    return await callback();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lockPath); } catch { /* keep lock failure visible through the operation result */ }
  }
}

function jsonPrint(valueToPrint) { process.stdout.write(`${JSON.stringify(valueToPrint)}\n`); }
function humanPrint(valueToPrint) { process.stdout.write(`${typeof valueToPrint === "string" ? valueToPrint : JSON.stringify(valueToPrint, null, 2)}\n`); }
function success(valueToPrint, code = EXIT.OK) { return { value: valueToPrint, exitCode: code }; }

async function configCheck(ctx, { allowMissingData = false, requireBackup = false, synthetic = false } = {}) {
  const inspection = inspectConfig(ctx, { allowMissingData, requireBackup });
  if (!inspection.ok && !synthetic) return success({ ok: false, command: "config check", profile: ctx.profileName, checks: inspection.checks }, EXIT.CONFIG);
  try {
    const compose = await composeConfigCheck(ctx, { synthetic, scheduler: false });
    return success({ ok: inspection.ok && compose.ok, command: "config check", profile: ctx.profileName, compose_project: ctx.project, compose_file: path.relative(ROOT, ctx.composeFile), checks: inspection.checks, compose: compose.detail }, inspection.ok ? EXIT.OK : EXIT.CONFIG);
  } catch (error) {
    if (error instanceof ManagementError) return success({ ok: false, command: "config check", profile: ctx.profileName, checks: inspection.checks, error: { code: error.code, message: error.message } }, error.exitCode);
    throw error;
  }
}

async function install(ctx) {
  profileRequiresExplicitMutation(ctx);
  await requireDocker(ctx);
  return withManagementLock(ctx, "install", async () => {
    const configured = configValues(ctx);
    const inspection = inspectConfig(ctx, { allowMissingData: true });
    if (!inspection.ok) return success({ ok: false, command: "install", profile: ctx.profileName, checks: inspection.checks, next: "provide the required configuration and rerun install" }, EXIT.CONFIG);
    if (configured.data) directoryStat(configured.data, "data directory", { allowMissing: true }).missing && fs.mkdirSync(safePath(configured.data, "data directory"), { recursive: true, mode: 0o700 });
    if (configured.backupDestination) directoryStat(configured.backupDestination, "backup destination", { allowMissing: true }).missing && fs.mkdirSync(safePath(configured.backupDestination, "backup destination"), { recursive: true, mode: 0o700 });
    const checked = await configCheck(ctx);
    return success({ ...checked.value, command: "install", installed: checked.exitCode === EXIT.OK, started: false, next: ["./manage.sh setup", "./manage.sh start", "./manage.sh health"] }, checked.exitCode);
  });
}

async function setup(ctx) {
  const checked = await configCheck(ctx, { allowMissingData: true });
  if (checked.exitCode !== EXIT.OK) return checked;
  const origin = value(ctx, "PRG32_FRONTEND_PUBLIC_ORIGIN") ?? "http://127.0.0.1:13000";
  const setupUrl = value(ctx, "PRG32_SETUP_URL") ?? `${origin.replace(/\/$/u, "")}/setup`;
  return success({ ok: true, command: "setup", profile: ctx.profileName, setup_url: setupUrl, action: "complete the application Setup Wizard; no bootstrap secret is printed" });
}

async function lifecycle(ctx, action, values) {
  profileRequiresExplicitMutation(ctx);
  await requireDocker(ctx);
  const checked = inspectConfig(ctx);
  if (!checked.ok) return success({ ok: false, command: action, profile: ctx.profileName, checks: checked.checks }, EXIT.CONFIG);
  const scheduler = values.scheduler;
  const composeAction = action === "start" ? ["up", "-d"] : action === "stop" ? ["stop"] : ["restart"];
  const result = await runCompose(ctx, composeAction, { scheduler });
  return success({ ok: true, command: action, profile: ctx.profileName, project: ctx.project, scheduler_selected: scheduler && ctx.profile.scheduler, output: redact(ctx, result.stdout).trim() || undefined }, EXIT.OK);
}

async function status(ctx) {
  await requireDocker(ctx);
  const rows = await composeServices(ctx, { scheduler: true });
  const services = servicesSummary(rows, ctx);
  const application = services.filter((item) => item.service !== "backup-scheduler");
  const running = application.length > 0 && application.every((item) => item.running);
  const healthy = application.length > 0 && application.every((item) => item.health === "healthy");
  const result = { ok: running, command: "status", profile: ctx.profileName, project: ctx.project, services, healthy, ready: healthy, endpoints: { store: value(ctx, "PRG32_FRONTEND_PUBLIC_ORIGIN") ?? null, api: value(ctx, "PRG32_API_PUBLIC_ORIGIN") ?? null }, configuration_present: inspectConfig(ctx, { allowMissingData: true }).ok };
  return success(result, running ? EXIT.OK : EXIT.UNHEALTHY);
}

async function logs(ctx, values) {
  const service = values.service ?? "backend";
  if (!Object.hasOwn(SERVICE_NAMES, service) || service === "scheduler" && !ctx.profile.scheduler) fail("service_invalid", `unknown or unavailable service: ${service}`, EXIT.USAGE);
  const composeService = SERVICE_NAMES[service];
  await requireDocker(ctx);
  if (values.follow && ctx.globals.json) fail("json_follow_unsupported", "--follow cannot be combined with --json", EXIT.USAGE);
  const args = ["logs", "--no-color", "--tail", String(values.tail), ...(values.follow ? ["--follow"] : []), composeService];
  if (values.follow) {
    const child = spawn("docker", composeArgs(ctx, args, { scheduler: service === "scheduler" }), { cwd: ROOT, env: process.env, stdio: "inherit" });
    const exitCode = await new Promise((resolve) => { child.on("error", () => resolve(EXIT.DEPENDENCY)); child.on("exit", (code) => resolve(code === 0 ? EXIT.OK : EXIT.FAILED)); });
    return success({ ok: exitCode === EXIT.OK, command: "logs", service, tail: values.tail, followed: true }, exitCode);
  }
  const result = await runCompose(ctx, args, { scheduler: service === "scheduler" });
  return success({ ok: true, command: "logs", service, tail: values.tail, output: result.stdout }, EXIT.OK);
}

async function doctor(ctx) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  try { ensureNode24(); add("node-24", "PASS", process.version); } catch (error) { add("node-24", "FAIL", error.message); }
  try { await requireDocker(ctx); add("docker-compose-v2", "PASS", "Docker daemon and Compose v2 available"); } catch (error) { add("docker-compose-v2", "FAIL", error.message); }
  const inspection = inspectConfig(ctx, { allowMissingData: true });
  for (const item of inspection.checks) add(item.name, item.status, item.detail);
  if (inspection.ok) {
    try { const rows = await composeServices(ctx, { scheduler: true }); add("compose-services", "PASS", `${rows.length} service records observed`); }
    catch (error) { add("compose-services", "WARN", error.message); }
  }
  const configured = configValues(ctx);
  if (configured.backupDestination) {
    try { directoryStat(configured.backupDestination, "backup destination"); add("backup-directory", "PASS", "regular directory"); } catch (error) { add("backup-directory", "WARN", error.message); }
  } else add("backup-directory", "NOT_APPLICABLE", "not configured; backup commands require an explicit destination");
  if (configured.keyRegistry) add("backup-key-registry", "PASS", "presence checked without reading key material");
  else add("backup-key-registry", "NOT_APPLICABLE", "candidate profile does not require a key registry");
  const ok = checks.every((item) => item.status !== "FAIL");
  return success({ ok, command: "doctor", profile: ctx.profileName, checks }, ok ? EXIT.OK : EXIT.CONFIG);
}

async function dbCheck(ctx, values) {
  const root = values.root ?? configValues(ctx).data;
  if (!root) fail("database_root_missing", "database root is not configured; use --root PATH", EXIT.CONFIG);
  const pnpm = "pnpm";
  const result = await runFile(pnpm, ["--dir", "backend", "run", "storage:integrity", "--", "--root", safePath(root, "database root")], ctx, { timeoutMs: ctx.globals.timeout * 1000 });
  const payload = parseJsonLines(result.stdout).at(-1) ?? { ok: false, error: "invalid_integrity_output" };
  return success({ command: "db check", profile: ctx.profileName, ...payload }, payload.ok === true ? EXIT.OK : EXIT.BACKUP);
}

function updateVersions(ctx) {
  const read = (file) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")).version ?? null; } catch { return null; } };
  return { management: VERSION, backend: read("backend/package.json"), frontend: read("frontend/package.json"), cli: read("cli/package.json") };
}

async function update(ctx, subcommand) {
  if (subcommand === "check") {
    return success({ ok: true, command: "update check", profile: ctx.profileName, status: "NO_UPDATE_SOURCE_CONFIGURED", current: updateVersions(ctx), source: value(ctx, "PRG32_UPDATE_SOURCE") ?? null, available: false, blockers: ["No trusted update source is configured; no remote code or git operation was attempted."] });
  }
  if (subcommand !== "apply") fail("usage", "update subcommand must be check or apply", EXIT.USAGE);
  profileRequiresExplicitMutation(ctx);
  const target = { fastify: value(ctx, "PRG32_UPDATE_TARGET_FASTIFY_IMAGE"), next: value(ctx, "PRG32_UPDATE_TARGET_NEXT_IMAGE") };
  const plan = { command: "update apply", profile: ctx.profileName, target, preflight: ["configuration", "secret paths", "health", "verified encrypted backup", "image and mount compatibility", "bounded readiness"], changes: ["selected application images only"], rollback: "database rollback is not automatic; post-write reconciliation is required" };
  if (ctx.globals.dryRun) return success({ ok: false, status: "BLOCKED", ...plan, blockers: ["No explicit trusted target image is configured.", "Update apply remains fail-closed in M5.5.4."] }, EXIT.BLOCKED);
  fail("update_apply_blocked", "update apply is intentionally fail-closed in M5.5.4; use the next authorized cutover milestone", EXIT.BLOCKED, plan);
}

async function build(ctx, values) {
  profileRequiresExplicitMutation(ctx);
  await requireDocker(ctx);
  const checked = inspectConfig(ctx, { allowMissingData: true });
  if (!checked.ok) return success({ ok: false, command: "build", profile: ctx.profileName, checks: checked.checks }, EXIT.CONFIG);
  const services = [...ctx.profile.services, ...(values.scheduler && ctx.profile.scheduler ? ["backup-scheduler"] : [])];
  const result = await runCompose(ctx, ["build", ...services], { scheduler: values.scheduler });
  return success({ ok: true, command: "build", profile: ctx.profileName, services, output: result.stdout }, EXIT.OK);
}

const backupCommand = createBackupCommand({
  root: ROOT,
  value,
  configValues,
  directoryStat,
  safePath,
  regularStat,
  runFile,
  parseJsonLines,
  profileRequiresExplicitMutation,
  success
});

const healthCommand = createHealthCommand({
  runCompose,
  parseJsonLines,
  composeServices,
  servicesSummary,
  requireDocker,
  success
});

const deployCommand = createDeployCommand({
  root: ROOT,
  configCheck,
  value,
  requireDocker,
  profileRequiresExplicitMutation,
  withManagementLock,
  runCompose,
  health: healthCommand,
  success
});

const verificationCommands = createVerificationCommands({
  root: ROOT,
  ensureNode24,
  runFile,
  composeConfigCheck,
  profiles: PROFILES,
  success
});

async function execute(ctx) {
  const values = parseCommandArgs(ctx.commandArgs);
  const { command, subcommand } = ctx;
  if (!command) { commandHelp(); return success({ ok: true, command: "help" }); }
  if (command === "version") return success(VERSION);
  if (command === "install") return install(ctx);
  if (command === "setup") return setup(ctx);
  if (command === "config" && subcommand === "check") return configCheck(ctx);
  if (["start", "stop", "restart"].includes(command)) return lifecycle(ctx, command, values);
  if (command === "status") return status(ctx);
  if (command === "logs") return logs(ctx, values);
  if (command === "health") return healthCommand(ctx);
  if (command === "doctor") return doctor(ctx);
  if (command === "db" && subcommand === "check") return dbCheck(ctx, values);
  if (command === "backup") return backupCommand(ctx, subcommand);
  if (command === "update") return update(ctx, subcommand);
  if (command === "deploy") return deployCommand(ctx, values);
  if (command === "build") return build(ctx, values);
  if (command === "test") return verificationCommands.test(ctx);
  if (command === "ci" && subcommand === "check") {
    return verificationCommands.ci(ctx);
  }
  fail("usage", `unknown command or subcommand: ${command}${subcommand ? ` ${subcommand}` : ""}`, EXIT.USAGE);
}

export { EXIT, PROFILES, parseArgs, parseCommandArgs, normalizeComposeServices, redact };

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed.globals.version || parsed.command === "version") { process.stdout.write(`${VERSION}\n`); return EXIT.OK; }
    if (parsed.globals.help || parsed.command === "help" || !parsed.command) { commandHelp(parsed.command === "help" ? undefined : parsed.command); return EXIT.OK; }
    ensureNode24();
    const ctx = context(parsed);
    const result = await execute(ctx);
    if (ctx.globals.json) jsonPrint(result.value); else humanPrint(result.value);
    return result.exitCode;
  } catch (error) {
    const managementError = error instanceof ManagementError ? error : new ManagementError("manage_failed", "management operation failed", EXIT.FAILED);
    const payload = { ok: false, error: { code: managementError.code, message: managementError.message }, ...(managementError.details === undefined ? {} : { details: managementError.details }) };
    if (parsed?.globals?.json) jsonPrint(payload); else process.stderr.write(`Error [${managementError.code}]: ${managementError.message}\n`);
    return managementError.exitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exitCode = await main();
