import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { CANONICAL_READ_AUTHORIZATION } from "../src/storage-v2/read-mode.js";
import { createDisposableCanonicalReadFixture, disposeDifferentialFixtures } from "../src/storage-v2/differential/harness.js";

const repositoryRoot = path.resolve(process.cwd(), "..");
const firmwareRoot = path.resolve(repositoryRoot, "../PRG32");
const pythonCandidates = [path.join(repositoryRoot, ".venv313", "bin", "python"), "python3"];

function pythonExecutable(): string | undefined {
  return pythonCandidates.find((candidate) => candidate === "python3" || fs.existsSync(candidate));
}

function canonicalEnvironment(fixture: ReturnType<typeof createDisposableCanonicalReadFixture>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PRG32_BACKEND_DB: path.join(fixture.sourceRoot, "store.sqlite"),
    PRG32_BACKEND_STORE_DATA: fixture.sourceRoot,
    PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: fixture.targetRoot,
    PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: CANONICAL_READ_AUTHORIZATION
  };
}

async function runFirmwareHostCommand(python: string, code: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", code, ...args], {
      cwd: firmwareRoot,
      env: { ...process.env, PYTHONPATH: firmwareRoot, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`firmware host client timed out: ${stderr}`));
    }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

afterEach(() => disposeDifferentialFixtures());

describe("actual PRG32 host-client runtime acceptance", () => {
  it("uses ../PRG32 store_api.py against disposable Fastify discovery, catalog and download routes", async () => {
    const python = pythonExecutable();
    expect(python, "python3 or the repository test virtualenv is required for host-client acceptance").toBeDefined();
    if (!python) return;

    const fixture = createDisposableCanonicalReadFixture();
    const app = buildApp({ config: loadConfig(canonicalEnvironment(fixture)), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = address.replace(/\/$/u, "");
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prg32-host-client-")), "alpha.prg32");
    try {
      const discovery = await fetch(`${baseUrl}/.well-known/prg32-store.json`);
      expect(discovery.status).toBe(200);
      expect((await discovery.json()) as { abi: string }).toMatchObject({ abi: "prg32-store-discovery-1.0" });

      const list = await runFirmwareHostCommand(python, "import argparse; from prg32.store.store_api import store_list; store_list(argparse.Namespace(store_url=__import__('sys').argv[1], token=None, architecture='qemu'))", [baseUrl], {});
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout).toContain("org.example.alpha");

      const expectedDownload = await fetch(`${baseUrl}/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu`);
      expect(expectedDownload.status).toBe(200);
      const expectedBytes = Buffer.from(await expectedDownload.arrayBuffer());
      const expectedSha256 = crypto.createHash("sha256").update(expectedBytes).digest("hex");
      const download = await runFirmwareHostCommand(python, "import argparse; from prg32.store.store_api import store_download; store_download(argparse.Namespace(store_url=__import__('sys').argv[1], token=None, game_id='org.example.alpha', architecture='qemu', version='2.0.0', out=__import__('sys').argv[2]))", [baseUrl, output], {});
      expect(download.status, download.stderr).toBe(0);
      const bytes = fs.readFileSync(output);
      expect(bytes.length).toBeGreaterThan(72);
      expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(expectedSha256);

      const detail = await fetch(`${baseUrl}/api/games/org.example.alpha?version=2.0.0`);
      const detailBody = await detail.json() as { game: { metadata: { abi: string }; colophon?: { abi: string } } };
      expect(detail.status).toBe(200);
      expect(detailBody.game.metadata.abi).toBe("prg32-metadata-1.0");
      const colophon = await fetch(`${baseUrl}/api/games/org.example.alpha/colophon?version=2.0.0`);
      expect(colophon.status).toBe(200);
      expect((await colophon.json()) as { colophon: { abi: string } }).toMatchObject({ colophon: { abi: "prg32-colophon-1.0" } });
    } finally {
      fs.rmSync(path.dirname(output), { recursive: true, force: true });
      await app.close();
    }
  }, 60_000);
});
