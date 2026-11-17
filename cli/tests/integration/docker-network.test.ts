import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../../backend/src/app.js";
import { loadConfig } from "../../../backend/src/config/env.js";
import { generateRegistryDocument } from "../../../backend/src/secrets/registry.js";
import { initializeDisposableStorage } from "../../../backend/src/storage-v2/database.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const cliImage = "prg32-store-cli:local";
const backendImage = "prg32-cartridge-store-fastify:m544b";
const root = path.join(repositoryRoot, ".local", "cli-m544b");
const canonicalRoot = path.join(root, "canonical");
const secretsRoot = path.join(root, "secrets");
const certificatesRoot = path.join(root, "certificates");
const runtimeRoot = path.join(root, "runtime");
const fixturesRoot = path.join(root, "fixtures");
const caCertificate = path.join(certificatesRoot, "ca.crt");
const certificate = path.join(certificatesRoot, "server.crt");
const privateKey = path.join(certificatesRoot, "server.key");
const caPrivateKey = path.join(certificatesRoot, "ca.key");
const nginxConfig = path.join(runtimeRoot, "nginx.conf");
const keyRegistry = path.join(secretsRoot, "key-registry.json");
const networkName = `prg32-m544b-private-${process.pid}-${Date.now()}`;
const backendContainer = `prg32-m544b-fastify-${process.pid}`;
const tlsContainer = `prg32-m544b-tls-${process.pid}`;
const tlsHost = "fastify.m544b.test";
const wrongHost = "wrong.m544b.test";
const tlsPort = "8443";
const bootstrapToken = "m544b-disposable-bootstrap-token-1234567890";
const sessionSecret = "m544b-disposable-session-secret-1234567890";
const password = "long-password-123";
const cliRuntime = path.join(root, "cli-runtime");
let app: ReturnType<typeof buildApp> | undefined;
let rootCreated = false;
let dockerNetworkCreated = false;

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function ensureFreshRoot(): void {
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(root).length > 0) throw new Error("M5.4.4b root exists and is not a fresh safe directory");
    throw new Error("M5.4.4b root already exists; refusing to reuse it");
  }
  execFileSync("git", ["check-ignore", "--quiet", ".local"], { cwd: repositoryRoot });
  fs.mkdirSync(canonicalRoot, { recursive: true, mode: 0o700 });
  for (const directory of [secretsRoot, certificatesRoot, runtimeRoot, fixturesRoot, cliRuntime]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.statfsSync(root);
  if (stats.bavail * stats.bsize < 256 * 1024 * 1024) throw new Error("insufficient disposable filesystem capacity");
  rootCreated = true;
}

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  return (Array.isArray(value) ? value[0] : value ?? "").split(";", 1)[0] ?? "";
}

async function csrf(currentApp: ReturnType<typeof buildApp>, currentCookie: string): Promise<{ cookie: string; token: string }> {
  const response = await currentApp.inject({ method: "GET", url: "/auth/csrf", headers: { cookie: currentCookie } });
  expect(response.statusCode).toBe(200);
  const token = response.json<{ csrf_token?: string }>().csrf_token;
  if (!token) throw new Error("disposable auth did not issue a CSRF token");
  return { cookie: cookie(response) || currentCookie, token };
}

async function login(currentApp: ReturnType<typeof buildApp>, username: string): Promise<{ cookie: string; csrf: string }> {
  const initial = await csrf(currentApp, "");
  const response = await currentApp.inject({ method: "POST", url: "/auth/login", headers: { cookie: initial.cookie, "x-csrftoken": initial.token }, payload: { username, password } });
  expect(response.statusCode).toBe(200);
  const session = await csrf(currentApp, cookie(response));
  return { cookie: session.cookie, csrf: session.token };
}

async function createToken(currentApp: ReturnType<typeof buildApp>, session: { cookie: string; csrf: string }, label: string): Promise<string> {
  const response = await currentApp.inject({ method: "POST", url: "/auth/tokens", headers: { cookie: session.cookie, "x-csrftoken": session.csrf }, payload: { label } });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string }>().token;
}

function run(command: string, args: readonly string[], options: { readonly maxBuffer?: number } = {}): Promise<CommandResult> {
  return execFileAsync(command, args, { cwd: repositoryRoot, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024 })
    .then((result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }))
    .catch((error: unknown) => {
      const value = error as { code?: number | string; stdout?: string; stderr?: string };
      return { code: typeof value.code === "number" ? value.code : 1, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
    });
}

async function dockerRun(args: readonly string[]): Promise<CommandResult> {
  return run("docker", ["run", "--rm", ...args]);
}

function json(result: CommandResult): Record<string, unknown> {
  expect(result.stdout.trim()).not.toBe("");
  expect(result.stdout.includes("\u001b") || result.stdout.includes("\u009b")).toBe(false);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function assertSuccess(result: CommandResult): Record<string, unknown> {
  expect(result.code, `${result.stdout.trim()} ${result.stderr.trim()}`.trim()).toBe(0);
  expect(result.stderr).toBe("");
  return json(result);
}

function openssl(args: readonly string[]): void {
  const result = runSync("openssl", args);
  if (result !== 0) throw new Error("synthetic TLS material generation failed");
}

function runSync(command: string, args: readonly string[]): number {
  try {
    execFileSync(command, args, { cwd: repositoryRoot, stdio: "ignore" });
    return 0;
  } catch (error) {
    const value = error as { status?: number | null };
    return typeof value.status === "number" ? value.status : 1;
  }
}

function generateCertificates(): void {
  const extensionFile = path.join(certificatesRoot, "server.ext");
  fs.writeFileSync(extensionFile, "authorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:fastify.m544b.test\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caPrivateKey, "-out", caCertificate, "-days", "1", "-subj", "/CN=PRG32 M5.4.4b Test CA"]);
  const request = path.join(certificatesRoot, "server.csr");
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey, "-out", request, "-subj", "/CN=fastify.m544b.test"]);
  openssl(["x509", "-req", "-in", request, "-CA", caCertificate, "-CAkey", caPrivateKey, "-CAcreateserial", "-out", certificate, "-days", "1", "-sha256", "-extfile", extensionFile]);
  for (const file of [caPrivateKey, request, privateKey, extensionFile]) {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
  fs.chmodSync(caCertificate, 0o644);
  fs.chmodSync(certificate, 0o644);
}

function generateNginxConfig(): void {
  fs.writeFileSync(nginxConfig, `events {}
http {
  upstream prg32_fastify { server fastify:5080; }
  server {
    listen 8443 ssl;
    server_name ${tlsHost};
    ssl_certificate /etc/nginx/certs/server.crt;
    ssl_certificate_key /etc/nginx/certs/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
      proxy_pass http://prg32_fastify;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
  }
}
`, { mode: 0o600 });
}

function cliArguments(command: readonly string[], host = tlsHost): string[] {
  return ["--json", "--server", `https://${host}:${tlsPort}`, ...command];
}

function cliDockerArgs(command: readonly string[], options: { readonly token?: string; readonly network?: string; readonly ca?: boolean; readonly host?: string } = {}): string[] {
  const network = options.network ?? networkName;
  const args = ["--network", network, "--mount", `type=bind,src=${caCertificate},dst=/run/m544b-certs/ca.crt,readonly`, "--env", "XDG_CONFIG_HOME=/tmp/prg32-cli", "--env", `NODE_EXTRA_CA_CERTS=${options.ca === false ? "/does-not-exist/ca.crt" : "/run/m544b-certs/ca.crt"}`];
  if (options.token !== undefined) args.push("--env", `PRG32_STORE_TOKEN=${options.token}`);
  args.push(cliImage, ...cliArguments(command, options.host ?? tlsHost));
  return args;
}

async function waitForBackend(): Promise<void> {
  const startedAt = Date.now();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await run("docker", ["exec", backendContainer, "node", "-e", "fetch('http://127.0.0.1:5080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { maxBuffer: 64 * 1024 });
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const state = await run("docker", ["inspect", backendContainer, "--format", "{{json .State}}"], { maxBuffer: 64 * 1024 });
  const logs = await run("docker", ["logs", backendContainer], { maxBuffer: 256 * 1024 });
  const elapsedMs = Date.now() - startedAt;
  const diagnostics = `${state.stdout.trim()} ${state.stderr.trim()} ${logs.stdout} ${logs.stderr}`
    .replace(/(?:token|secret|password)=[^\s]+/giu, "$1=<redacted>")
    .trim();
  throw new Error(`disposable Fastify container did not become ready after ${elapsedMs}ms: ${diagnostics}`);
}

beforeAll(async () => {
  ensureFreshRoot();
  const cliBuild = await run("docker", ["build", "-f", "cli/Dockerfile", "-t", cliImage, "."]);
  expect(cliBuild.code, `${cliBuild.stdout.trim()} ${cliBuild.stderr.trim()}`.trim()).toBe(0);
  const backendBuild = await run("docker", ["build", "-f", "backend/Dockerfile.operational", "-t", backendImage, "backend"], { maxBuffer: 8 * 1024 * 1024 });
  expect(backendBuild.code, `${backendBuild.stdout.trim()} ${backendBuild.stderr.trim()}`.trim()).toBe(0);
  fs.writeFileSync(keyRegistry, generateRegistryDocument("m544b-test-key"), { mode: 0o600 });
  generateCertificates();
  generateNginxConfig();
  initializeDisposableStorage(canonicalRoot).close();
  const shadowRoot = path.join(runtimeRoot, "shadow");
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
    PRG32_BACKEND_SESSION_SECRET: sessionSecret,
    PRG32_BACKEND_BOOTSTRAP_TOKEN: bootstrapToken,
    PRG32_BACKEND_SESSION_SECURE: "false",
    PRG32_BACKEND_MDNS_ENABLED: "false",
    PRG32_BACKEND_FEDERATION_ENABLED: "false",
    PRG32_BACKEND_WEBAUTHN_ENABLED: "false",
    PRG32_BACKEND_EMAIL_TRANSPORT: "disabled"
  });
  const previousCwd = process.cwd();
  process.chdir(runtimeRoot);
  try { app = buildApp({ config, logger: false }); } finally { process.chdir(previousCwd); }
  const bootstrap = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": bootstrapToken }, payload: { username: "m544b-admin", email: "m544b-admin@example.test", password, password_confirm: password } });
  expect(bootstrap.statusCode).toBe(201);
  const adminSession = await csrf(app, cookie(bootstrap));
  const ordinary = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: adminSession.cookie, "x-csrftoken": adminSession.token }, payload: { username: "m544b-ordinary", email: "m544b-ordinary@example.test", password, password_confirm: password } });
  expect(ordinary.statusCode).toBe(201);
  const adminToken = await createToken(app, { cookie: adminSession.cookie, csrf: adminSession.token }, "m544b admin read");
  const ordinaryToken = await createToken(app, await login(app, "m544b-ordinary"), "m544b ordinary read");
  fs.writeFileSync(path.join(runtimeRoot, "token-presence"), "synthetic tokens created through supported APIs\n", { mode: 0o600 });
  await app.close();
  app = undefined;

  const uid = String(typeof process.getuid === "function" ? process.getuid() : 1000);
  const gid = String(typeof process.getgid === "function" ? process.getgid() : 1000);
  const network = await run("docker", ["network", "create", "--driver", "bridge", "--internal", networkName]);
  expect(network.code).toBe(0);
  dockerNetworkCreated = true;
  const backend = await run("docker", ["run", "-d", "--name", backendContainer, "--user", `${uid}:${gid}`, "--network", networkName, "--network-alias", "fastify", "--network-alias", tlsHost, "--mount", `type=bind,src=${canonicalRoot},dst=/data/canonical`, "--mount", `type=bind,src=${keyRegistry},dst=/run/secrets/prg32-key-registry,readonly`, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--env", "NODE_ENV=production", "--env", "PRG32_BACKEND_HOST=0.0.0.0", "--env", "PRG32_BACKEND_PORT=5080", "--env", "PRG32_BACKEND_DB=/data/canonical/store.sqlite", "--env", "PRG32_BACKEND_STORE_DATA=/data/canonical", "--env", "PRG32_BACKEND_CATALOG_READ_MODE=canonical-operational", "--env", "PRG32_BACKEND_CANONICAL_STORAGE_ROOT=/data/canonical", "--env", "PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION=M5.2G1-OPERATIONAL-CANONICAL-READ", "--env", "PRG32_BACKEND_CANONICAL_WORKFLOW_MODE=operational", "--env", "PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION=M5.2G2-DISPOSABLE-OPERATIONAL-WRITE-ACCEPTANCE", "--env", "PRG32_BACKEND_AUTH_WRITE_ENABLED=true", "--env", "PRG32_BACKEND_AUTH_WRITE_MODE=operational", "--env", "PRG32_BACKEND_AUTH_WRITE_DB=/data/canonical/store.sqlite", "--env", "PRG32_BACKEND_AUTH_DISPOSABLE_ROOT=/data/canonical", "--env", `PRG32_BACKEND_SESSION_SECRET=${sessionSecret}`, "--env", `PRG32_BACKEND_BOOTSTRAP_TOKEN=${bootstrapToken}`, "--env", "PRG32_BACKEND_SESSION_SECURE=true", "--env", "PRG32_BACKEND_TRUST_PROXY=true", "--env", "PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN=https://store.m544b.test", "--env", `PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN=https://${tlsHost}`, "--env", `PRG32_BACKEND_OIDC_PUBLIC_ORIGIN=https://${tlsHost}`, "--env", "PRG32_BACKEND_CORS_ORIGINS=https://store.m544b.test", "--env", "PRG32_BACKEND_EMAIL_TRANSPORT=disabled", "--env", "PRG32_BACKEND_BACKUP_ENABLED=false", "--env", "PRG32_BACKEND_SECRET_ENCRYPTION_ENABLED=true", "--env", "PRG32_BACKEND_SECRET_KEY_REGISTRY=/run/secrets/prg32-key-registry", "--env", "PRG32_BACKEND_MDNS_ENABLED=false", "--env", "PRG32_BACKEND_WEBAUTHN_ENABLED=false", backendImage]);
  expect(backend.code, `${backend.stdout.trim()} ${backend.stderr.trim()}`.trim()).toBe(0);
  const tls = await run("docker", ["run", "-d", "--name", tlsContainer, "--network", networkName, "--network-alias", tlsHost, "--network-alias", wrongHost, "--mount", `type=bind,src=${certificate},dst=/etc/nginx/certs/server.crt,readonly`, "--mount", `type=bind,src=${privateKey},dst=/etc/nginx/certs/server.key,readonly`, "--mount", `type=bind,src=${nginxConfig},dst=/etc/nginx/nginx.conf,readonly`, "nginx:1.27-alpine", "nginx", "-g", "daemon off;"]);
  expect(tls.code, `${tls.stdout.trim()} ${tls.stderr.trim()}`.trim()).toBe(0);
  await waitForBackend();
  fs.writeFileSync(path.join(runtimeRoot, "tokens.json"), JSON.stringify({ adminToken, ordinaryToken }), { mode: 0o600 });
}, 180_000);

afterAll(async () => {
  await app?.close();
  for (const container of [tlsContainer, backendContainer]) await run("docker", ["rm", "-f", container], { maxBuffer: 64 * 1024 });
  if (dockerNetworkCreated) await run("docker", ["network", "rm", networkName], { maxBuffer: 64 * 1024 });
  if (rootCreated) fs.rmSync(root, { recursive: true, force: true });
}, 30_000);

describe("M5.4.4b Docker CLI network acceptance", () => {
  it("runs the actual CLI image through private Docker DNS and synthetic HTTPS", async () => {
    const tokens = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "tokens.json"), "utf8")) as { adminToken: string; ordinaryToken: string };
    const correct = (command: readonly string[], options: { readonly token?: string; readonly host?: string; readonly ca?: boolean } = {}) => dockerRun(cliDockerArgs(command, options));

    const version = await dockerRun(["--network", networkName, cliImage, "--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe("0.1.0");
    expect(version.stderr).toBe("");

    const statusResult = await correct(["status"]);
    if (statusResult.code !== 0) {
      const tlsLogs = await run("docker", ["logs", tlsContainer], { maxBuffer: 256 * 1024 });
      throw new Error(`disposable TLS proxy was not reachable: ${tlsLogs.stdout} ${tlsLogs.stderr}`.replace(/(?:token|secret|password)=[^\s]+/giu, "$1=<redacted>"));
    }
    const status = assertSuccess(statusResult);
    expect(status).toHaveProperty("health");
    expect(assertSuccess(await correct(["doctor"]))).toHaveProperty("checks");
    expect(assertSuccess(await correct(["games", "list"]))).toHaveProperty("games");
    expect(assertSuccess(await correct(["users", "list"], { token: tokens.adminToken }))).toHaveProperty("users");
    expect((await correct(["users", "list"])).code).toBe(3);
    expect((await correct(["users", "list"], { token: tokens.ordinaryToken })).code).toBe(3);

    expect((await correct(["status"], { ca: false })).code).toBe(6);
    expect((await correct(["status"], { host: wrongHost })).code).toBe(6);
    expect((await correct(["status"], { ca: false, host: tlsHost })).code).toBe(6);
    expect((await dockerRun(["--network", networkName, "--env", "XDG_CONFIG_HOME=/tmp/prg32-cli", cliImage, "--json", "--server", `http://${tlsHost}:5080`, "games", "list"])).code).toBe(2);
    expect((await dockerRun(["--network", "none", "--mount", `type=bind,src=${caCertificate},dst=/run/m544b-certs/ca.crt,readonly`, "--env", "NODE_EXTRA_CA_CERTS=/run/m544b-certs/ca.crt", cliImage, ...cliArguments(["status"])] )).code).toBe(6);
    expect((await dockerRun(["--network", networkName, cliImage, "--json", "games", "list"])).code).toBe(2);
  }, 180_000);
});
