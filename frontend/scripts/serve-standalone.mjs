import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const frontendRoot = resolve(import.meta.dirname, "..");
const distDir = process.env.PRG32_STANDALONE_DIST_DIR?.trim() || ".next";
if (!/^\.next-[A-Za-z0-9._-]+$/u.test(distDir) && distDir !== ".next") {
  throw new Error("PRG32_STANDALONE_DIST_DIR must be .next or an isolated .next-* directory");
}
const standaloneSource = join(frontendRoot, distDir, "standalone");
const staticSource = join(frontendRoot, distDir, "static");
const publicSource = join(frontendRoot, "public");
const host = "127.0.0.1";
const port = Number(process.env.PRG32_STANDALONE_PORT ?? "3100");

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PRG32_STANDALONE_PORT must be a loopback TCP port between 1024 and 65535");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForHttp(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`standalone server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`standalone server did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function verifyRuntime(baseUrl) {
  const home = await fetch(`${baseUrl}/`);
  if (!home.ok) throw new Error(`homepage returned HTTP ${home.status}`);
  const html = await home.text();
  if (!html.includes("Build cartridges")) throw new Error("homepage marker was not found");

  const cssAsset = html.match(/\/_next\/static\/[^"'\s]+\.css/iu)?.[0];
  const jsAsset = html.match(/\/_next\/static\/[^"'\s]+\.js/iu)?.[0];
  if (!cssAsset || !(await fetch(`${baseUrl}${cssAsset}`)).ok) throw new Error("CSS asset delivery failed");
  if (!jsAsset || !(await fetch(`${baseUrl}${jsAsset}`)).ok) throw new Error("JavaScript asset delivery failed");

  for (const path of ["/manifest.webmanifest", "/static/icon-192.svg"]) {
    const response = await fetch(`${baseUrl}${path}`);
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  }
}

const runtimeRoot = await mkdtemp(join(tmpdir(), "prg32-cartridge-store-standalone-"));
let child;
let shuttingDown = false;

async function cleanup(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(runtimeRoot, { recursive: true, force: true });
  process.exit(exitCode);
}

process.once("SIGINT", () => void cleanup(130));
process.once("SIGTERM", () => void cleanup(143));

try {
  if (!(await exists(standaloneSource))) throw new Error(".next/standalone is missing; run the production build first");
  if (!(await exists(staticSource))) throw new Error(".next/static is missing; run the production build first");

  await cp(standaloneSource, runtimeRoot, { recursive: true });
  await cp(staticSource, join(runtimeRoot, distDir, "static"), { recursive: true });
  if (await exists(publicSource)) await cp(publicSource, join(runtimeRoot, "public"), { recursive: true });

  const serverPath = join(runtimeRoot, "server.js");
  if (!(await exists(serverPath))) throw new Error("standalone server.js is missing");
  const copiedEntries = await readdir(runtimeRoot);
  if (!copiedEntries.includes("server.js")) throw new Error("standalone runtime root is incomplete");

  child = spawn(process.execPath, [serverPath], {
    cwd: runtimeRoot,
    env: { ...process.env, NODE_ENV: "production", HOSTNAME: host, PORT: String(port) },
    stdio: "inherit",
  });
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`standalone server exited unexpectedly (${code ?? signal})`);
      void cleanup(code ?? 1);
    }
  });

  const baseUrl = `http://${host}:${port}`;
  await waitForHttp(baseUrl, child);
  await verifyRuntime(baseUrl);
  console.log(`standalone runtime ready at ${baseUrl}; staged files are isolated in a temporary directory`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await cleanup(1);
}
