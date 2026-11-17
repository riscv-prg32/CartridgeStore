import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../../backend/src/app.js";
import { loadConfig } from "../../../backend/src/config/env.js";
import { generateRegistryDocument } from "../../../backend/src/secrets/registry.js";
import { auditStorage } from "../../../backend/src/storage-v2/integrity.js";
import { initializeDisposableStorage, openTargetStorage } from "../../../backend/src/storage-v2/database.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const cliEntrypoint = path.join(repositoryRoot, "cli", "dist", "main.js");
const root = path.join(repositoryRoot, ".local", "cli-m544a");
const canonicalRoot = path.join(root, "data", "canonical");
const shadowRoot = path.join(root, "runtime", "shadow");
const secretsRoot = path.join(root, "secrets");
const backupsRoot = path.join(root, "backups");
const restoresRoot = path.join(root, "restores");
const fixturesRoot = path.join(root, "fixtures");
const runtimeRoot = path.join(root, "runtime");
const keyRegistry = path.join(secretsRoot, "key-registry.json");
const wrongKeyRegistry = path.join(secretsRoot, "wrong-key-registry.json");
const backupArchive = path.join(backupsRoot, "cli-acceptance.backup4");
const restoredRoot = path.join(restoresRoot, "restored");
const nonEmptyRestoreRoot = path.join(restoresRoot, "non-empty");
const serverUrl = { value: "" };
let app: ReturnType<typeof buildApp> | undefined;
let appRootCreated = false;

const BOOTSTRAP = "m544a-disposable-bootstrap-token-1234567890";
const SESSION_SECRET = "m544a-disposable-session-secret-1234567890";
const PASSWORD = "long-password-123";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function ensureFreshRoot(): void {
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(root).length > 0) throw new Error("M5.4.4a root exists and is not a fresh safe directory");
    throw new Error("M5.4.4a root already exists; refusing to reuse it");
  }
  execFileSync("git", ["check-ignore", "--quiet", ".local"], { cwd: repositoryRoot });
  fs.mkdirSync(canonicalRoot, { recursive: true, mode: 0o700 });
  for (const directory of [secretsRoot, backupsRoot, restoresRoot, fixturesRoot, runtimeRoot]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const free = fs.statfsSync(root).bavail * fs.statfsSync(root).bsize;
  if (free < 128 * 1024 * 1024) throw new Error("insufficient disposable filesystem capacity");
  appRootCreated = true;
}

function legacyCartridge(): Buffer {
  const bytes = Buffer.alloc(84);
  bytes.write("PRG2", 0, "ascii");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(72, 8);
  bytes.writeUInt32LE(12, 16);
  Buffer.from("130000001300000013000000", "hex").copy(bytes, 72);
  return bytes;
}

function bundle(id: string, title = "CLI Acceptance Cartridge"): Buffer {
  return Buffer.from(zipSync({
    "manifest.json": Buffer.from(JSON.stringify({
      abi: "prg32-metadata-1.0",
      id,
      title,
      version: "1.0.0",
      authors: [{ name: "PRG32" }],
      tags: ["cli", "acceptance"],
      assets: { icon: "icon.png" },
      architectures: [{ id: "qemu", file: "game-qemu.prg32" }]
    })),
    "icon.png": PNG,
    "game-qemu.prg32": legacyCartridge()
  }));
}

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  return (Array.isArray(value) ? value[0] : value ?? "").split(";", 1)[0] ?? "";
}

async function csrf(currentApp: ReturnType<typeof buildApp>, currentCookie: string): Promise<{ cookie: string; token: string }> {
  const response = await currentApp.inject({ method: "GET", url: "/auth/csrf", headers: { cookie: currentCookie } });
  expect(response.statusCode).toBe(200);
  const token = response.json<{ csrf_token?: string }>().csrf_token;
  if (!token) throw new Error(`csrf token was not issued: ${response.body}`);
  return { cookie: cookie(response) || currentCookie, token };
}

async function login(currentApp: ReturnType<typeof buildApp>, username: string): Promise<{ cookie: string; csrf: string }> {
  const initial = await csrf(currentApp, "");
  const response = await currentApp.inject({ method: "POST", url: "/auth/login", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { username, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  const sessionCookie = cookie(response);
  const current = await csrf(currentApp, sessionCookie);
  return { cookie: current.cookie, csrf: current.token };
}

async function createToken(currentApp: ReturnType<typeof buildApp>, session: { cookie: string; csrf: string }, label: string): Promise<string> {
  const response = await currentApp.inject({ method: "POST", url: "/auth/tokens", headers: { cookie: session.cookie, "x-csrftoken": session.csrf }, payload: { label } });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string }>().token;
}

async function runCli(args: readonly string[], token?: string): Promise<CliResult> {
  const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(runtimeRoot, "xdg") };
  delete environment.PRG32_STORE_TOKEN;
  delete environment.PRG32_STORE_TOKEN_FILE;
  if (token !== undefined) environment.PRG32_STORE_TOKEN = token;
  try {
    const result = await execFileAsync(process.execPath, [cliEntrypoint, ...args], { cwd: repositoryRoot, env: environment, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const value = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof value.code === "number" ? value.code : 1, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
  }
}

function json(result: CliResult): Record<string, unknown> {
  expect(result.stdout.trim()).not.toBe("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function expectSuccess(result: CliResult): Record<string, unknown> {
  expect(result.code, `${result.stdout.trim()} ${result.stderr.trim()}`.trim()).toBe(0);
  expect(result.stderr).toBe("");
  return json(result);
}

function copyArchive(source: string, destination: string): void {
  fs.copyFileSync(source, destination);
  fs.copyFileSync(`${source}.complete.json`, `${destination}.complete.json`);
}

beforeAll(async () => {
  ensureFreshRoot();
  fs.writeFileSync(keyRegistry, generateRegistryDocument("m544a-test-key"), { mode: 0o600 });
  fs.writeFileSync(wrongKeyRegistry, generateRegistryDocument("m544a-wrong-key"), { mode: 0o600 });
  initializeDisposableStorage(canonicalRoot).close();
  initializeDisposableStorage(shadowRoot).close();
  const config = loadConfig({
    NODE_ENV: "test",
    PRG32_BACKEND_DB: path.join(shadowRoot, "store.sqlite"),
    PRG32_BACKEND_STORE_DATA: shadowRoot,
    PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: canonicalRoot,
    PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: "M5.2G1-DISPOSABLE-CANONICAL-READ",
    PRG32_BACKEND_CANONICAL_WORKFLOW_MODE: "disposable",
    PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION: "M5.2G2-DISPOSABLE-CANONICAL-WRITE",
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: path.join(canonicalRoot, "store.sqlite"),
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: canonicalRoot,
    PRG32_BACKEND_SUBMISSION_WRITE_ENABLED: "true",
    PRG32_BACKEND_SUBMISSION_WRITE_MODE: "test",
    PRG32_BACKEND_SUBMISSION_DISPOSABLE_ROOT: canonicalRoot,
    PRG32_BACKEND_SESSION_SECRET: SESSION_SECRET,
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false",
    PRG32_BACKEND_MDNS_ENABLED: "false",
    PRG32_BACKEND_FEDERATION_ENABLED: "false",
    PRG32_BACKEND_WEBAUTHN_ENABLED: "false",
    PRG32_BACKEND_EMAIL_TRANSPORT: "disabled"
  });
  const previousCwd = process.cwd();
  process.chdir(runtimeRoot);
  try { app = buildApp({ config, logger: false }); } finally { process.chdir(previousCwd); }
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("Fastify did not expose a TCP port");
  serverUrl.value = `http://127.0.0.1:${address.port}`;
  const bootstrap = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": BOOTSTRAP }, payload: { username: "cli-admin", email: "cli-admin@example.test", password: PASSWORD, password_confirm: PASSWORD } });
  expect(bootstrap.statusCode).toBe(201);
  const adminSession = await csrf(app, cookie(bootstrap));
  const settings = await app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: adminSession.cookie, "x-csrftoken": adminSession.token }, payload: { application_settings: { "publishing.enabled": true } } });
  expect(settings.statusCode).toBe(200);
  const groups = await app.inject({ method: "GET", url: "/api/admin/groups", headers: { cookie: adminSession.cookie } });
  expect(groups.statusCode).toBe(200);
  const editors = groups.json<{ groups: Array<{ id: number; name: string }> }>().groups.find((group) => group.name === "editors");
  expect(editors).toBeDefined();
  const reviewer = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: adminSession.cookie, "x-csrftoken": adminSession.token }, payload: { username: "cli-reviewer", email: "cli-reviewer@example.test", password: PASSWORD, password_confirm: PASSWORD } });
  expect(reviewer.statusCode).toBe(201);
  const reviewerId = reviewer.json<{ user: { id: number } }>().user.id;
  const groupAssignment = await app.inject({ method: "PUT", url: `/api/admin/users/${reviewerId}/groups`, headers: { cookie: adminSession.cookie, "x-csrftoken": adminSession.token }, payload: { group_ids: [editors!.id] } });
  expect(groupAssignment.statusCode).toBe(200);
  const ordinary = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: adminSession.cookie, "x-csrftoken": adminSession.token }, payload: { username: "cli-ordinary", email: "cli-ordinary@example.test", password: PASSWORD, password_confirm: PASSWORD } });
  expect(ordinary.statusCode).toBe(201);
  const adminToken = await createToken(app, { cookie: adminSession.cookie, csrf: adminSession.token }, "cli acceptance admin");
  const reviewerToken = await createToken(app, await login(app, "cli-reviewer"), "cli acceptance reviewer");
  const ordinaryToken = await createToken(app, await login(app, "cli-ordinary"), "cli acceptance ordinary");
  fs.writeFileSync(path.join(runtimeRoot, "tokens.json"), JSON.stringify({ adminToken, reviewerToken, ordinaryToken }), { mode: 0o600 });
});

afterAll(async () => {
  await app?.close();
  if (appRootCreated) fs.rmSync(root, { recursive: true, force: true });
});

describe("M5.4.4a disposable CLI acceptance", () => {
  it("executes the real CLI against a real Fastify HTTP server and restores an encrypted canonical backup", async () => {
    const tokens = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "tokens.json"), "utf8")) as { adminToken: string; reviewerToken: string; ordinaryToken: string };
    const version = expectSuccess(await runCli(["--json", "version"]));
    expect(version.version).toBe("0.1.0");
    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage:");
    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "status"]))).toHaveProperty("health");
    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "doctor"]))).toHaveProperty("checks");
    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "games", "list"]))).toHaveProperty("games");
    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "games", "search", "--q", "cli"]))).toHaveProperty("games");
    const missingGame = await runCli(["--json", "--server", serverUrl.value, "games", "show", "--id", "org.example.missing"]);
    expect(missingGame.code, `${missingGame.stdout.trim()} ${missingGame.stderr.trim()}`.trim()).toBe(1);
    expect(missingGame.stderr).not.toMatch(/127\.0\.0\.1|token|secret|password/iu);

    const validBundle = path.join(fixturesRoot, "accepted.zip");
    const rejectedBundle = path.join(fixturesRoot, "rejected.zip");
    fs.writeFileSync(validBundle, bundle("org.example.cli.accepted"));
    fs.writeFileSync(rejectedBundle, bundle("org.example.cli.rejected", "Rejected CLI Cartridge"));
    expect(expectSuccess(await runCli(["--json", "cartridges", "validate", validBundle]))).toMatchObject({ id: "org.example.cli.accepted", version: "1.0.0", architectures: ["qemu"] });
    const upload = expectSuccess(await runCli(["--json", "--server", serverUrl.value, "cartridges", "upload", validBundle], tokens.ordinaryToken));
    const submissionId = Number(upload.submission_id);
    expect(Number.isSafeInteger(submissionId)).toBe(true);
    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "submissions", "list"], tokens.reviewerToken))).toHaveProperty("submissions");
    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "submissions", "show", "--id", String(submissionId)], tokens.reviewerToken))).toHaveProperty("submission");
    const approved = expectSuccess(await runCli(["--json", "--server", serverUrl.value, "submissions", "approve", "--id", String(submissionId), "--metadata", '{"title":"CLI Approved Cartridge"}'], tokens.reviewerToken));
    expect((approved.submission as Record<string, unknown>).status).toBe("verified");
    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "games", "show", "--id", "org.example.cli.accepted"]))).toHaveProperty("game");
    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "games", "search", "--q", "Approved"]))).toHaveProperty("games");
    const rejectedUpload = expectSuccess(await runCli(["--json", "--server", serverUrl.value, "cartridges", "upload", rejectedBundle], tokens.ordinaryToken));
    const rejectedId = Number(rejectedUpload.submission_id);
    const rejected = expectSuccess(await runCli(["--json", "--server", serverUrl.value, "submissions", "reject", "--id", String(rejectedId), "--note", "synthetic rejection"], tokens.reviewerToken));
    expect((rejected.submission as Record<string, unknown>).status).toBe("rejected");

    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "users", "list"], tokens.adminToken))).toHaveProperty("users");
    const users = expectSuccess(await runCli(["--json", "--server", serverUrl.value, "users", "list"], tokens.adminToken));
    const ordinaryUser = (users.users as Array<{ id: number; username: string }>).find((user) => user.username === "cli-ordinary");
    expect(ordinaryUser).toBeDefined();
    expect(expectSuccess(await runCli(["--json", "--server", serverUrl.value, "users", "show", "--id", String(ordinaryUser!.id)], tokens.adminToken))).toHaveProperty("user");
    expect((await runCli(["--json", "--server", serverUrl.value, "users", "list"])).code).toBe(3);
    expect((await runCli(["--json", "--server", serverUrl.value, "users", "list"], "prg32_invalid_acceptance_token")).code).toBe(3);
    expect((await runCli(["--json", "cartridges", "validate"])).code).toBe(2);

    const dockerAvailable = (() => { try { execFileSync("docker", ["image", "inspect", "prg32-store-cli:local"], { stdio: "ignore" }); return true; } catch { return false; } })();
    if (dockerAvailable) {
      const dockerVersion = await execFileAsync("docker", ["run", "--rm", "prg32-store-cli:local", "--version"], { cwd: repositoryRoot, env: { ...process.env }, maxBuffer: 1024 * 1024 });
      expect(dockerVersion.stdout.trim()).toBe("0.1.0");
      const dockerResult = await execFileAsync("docker", ["run", "--rm", "--network", "host", "prg32-store-cli:local", "--json", "--server", serverUrl.value, "games", "list"], { cwd: repositoryRoot, env: { ...process.env }, maxBuffer: 1024 * 1024 }).catch((error) => error as { stdout?: string; stderr?: string; code?: number });
      if ("code" in dockerResult && dockerResult.code !== undefined) {
        // Docker Desktop may not expose the host loopback to --network host; this is reported as NOT_VERIFIED.
        expect(`${dockerResult.stdout ?? ""}${dockerResult.stderr ?? ""}`).not.toMatch(/token|secret|password/iu);
      } else {
        expect(JSON.parse(dockerResult.stdout ?? "{}")).toHaveProperty("games");
      }
    }

    const activeWriterBackup = await runCli(["--json", "backup", "create", "--source", canonicalRoot, "--output", path.join(backupsRoot, "active-writer.backup4"), "--key-registry", keyRegistry]);
    expect(activeWriterBackup.code).toBe(5);
    expect(fs.existsSync(path.join(backupsRoot, "active-writer.backup4.complete.json"))).toBe(false);

    await app?.close();
    app = undefined;
    expectSuccess(await runCli(["--json", "backup", "create", "--source", canonicalRoot, "--output", backupArchive, "--key-registry", keyRegistry]));
    const listed = expectSuccess(await runCli(["--json", "backup", "list", "--directory", backupsRoot]));
    expect((listed.backups as Array<{ archive: string; completion_marker: boolean }>).some((item) => item.archive === backupArchive && item.completion_marker)).toBe(true);
    expectSuccess(await runCli(["--json", "backup", "verify", "--archive", backupArchive, "--key-registry", keyRegistry]));

    const wrongKey = await runCli(["--json", "backup", "verify", "--archive", backupArchive, "--key-registry", wrongKeyRegistry]);
    expect(wrongKey.code).toBe(7);
    const corruptArchive = path.join(backupsRoot, "corrupt.backup4");
    copyArchive(backupArchive, corruptArchive);
    fs.truncateSync(corruptArchive, Math.max(1, Math.floor(fs.statSync(corruptArchive).size / 2)));
    expect((await runCli(["--json", "backup", "verify", "--archive", corruptArchive, "--key-registry", keyRegistry])).code).toBe(7);
    const truncatedArchive = path.join(backupsRoot, "truncated.backup4");
    copyArchive(backupArchive, truncatedArchive);
    fs.truncateSync(truncatedArchive, 32);
    expect((await runCli(["--json", "backup", "verify", "--archive", truncatedArchive, "--key-registry", keyRegistry])).code).toBe(7);

    expect((await runCli(["--json", "backup", "restore", "--archive", backupArchive, "--target", restoredRoot, "--key-registry", keyRegistry])).code).toBe(2);
    expectSuccess(await runCli(["--json", "backup", "restore", "--yes", "--archive", backupArchive, "--target", restoredRoot, "--key-registry", keyRegistry]));
    const restored = openTargetStorage(restoredRoot, "read-only");
    try {
      expect(auditStorage(restored.sqlite, restored.paths).ok).toBe(true);
    } finally { restored.close(); }
    const sourceDb = openTargetStorage(canonicalRoot, "read-only");
    const restoredDb = openTargetStorage(restoredRoot, "read-only");
    for (const table of ["submissions", "publication_operations", "review_decisions", "storage_metadata"]) {
      const sourceCount = (sourceDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      const restoredCount = (restoredDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      expect(restoredCount, table).toBe(sourceCount);
    }
    expect(restoredDb.sqlite.prepare("SELECT submission_id, status FROM submissions ORDER BY submission_id").all()).toEqual(sourceDb.sqlite.prepare("SELECT submission_id, status FROM submissions ORDER BY submission_id").all());
    sourceDb.close();
    restoredDb.close();
    fs.mkdirSync(nonEmptyRestoreRoot, { recursive: true });
    fs.writeFileSync(path.join(nonEmptyRestoreRoot, "do-not-overwrite"), "sentinel");
    expect((await runCli(["--json", "backup", "restore", "--yes", "--archive", backupArchive, "--target", nonEmptyRestoreRoot, "--key-registry", keyRegistry])).code).toBe(5);
    expect(fs.readFileSync(path.join(nonEmptyRestoreRoot, "do-not-overwrite"), "utf8")).toBe("sentinel");

  }, 120_000);
});
