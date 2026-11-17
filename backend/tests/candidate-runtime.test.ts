import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { CANDIDATE_RUNTIME_AUTHORIZATION } from "../src/runtime/candidate.js";
import { initializeDisposableStorage } from "../src/storage-v2/database.js";
import { CANONICAL_READ_AUTHORIZATION, CANONICAL_WRITE_AUTHORIZATION } from "../src/storage-v2/read-mode.js";

const roots: string[] = [];

function environment(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PRG32_BACKEND_DB: path.join(root, "store.sqlite"),
    PRG32_BACKEND_STORE_DATA: root,
    PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: root,
    PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: CANONICAL_READ_AUTHORIZATION,
    PRG32_BACKEND_CANONICAL_WORKFLOW_MODE: "disposable",
    PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION: CANONICAL_WRITE_AUTHORIZATION,
    PRG32_BACKEND_CANDIDATE_MODE: "two-service-disposable",
    PRG32_BACKEND_CANDIDATE_AUTHORIZATION: CANDIDATE_RUNTIME_AUTHORIZATION,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: path.join(root, "store.sqlite"),
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: root,
    PRG32_BACKEND_SESSION_SECRET: "m52g9-disposable-session-secret-for-tests",
    PRG32_BACKEND_SESSION_SECURE: "false",
    PRG32_BACKEND_MDNS_ENABLED: "false",
    ...overrides
  };
}

function createRoot(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52g9-candidate-"));
  roots.push(parent);
  const root = path.join(parent, "canonical");
  initializeDisposableStorage(root).close();
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("disposable two-service candidate", () => {
  it("opens one canonical SQLite writer, reports canonical readiness, and releases its lease", async () => {
    const root = createRoot();
    const app = buildApp({ config: loadConfig(environment(root)), logger: false });
    await app.ready();
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ok: true,
      status: "ready",
      resources: { database: "available", canonical_storage: "available", writer_lease: "held" }
    });
    expect(fs.existsSync(path.join(root, "canonical-writer.lock"))).toBe(true);
    await app.close();
    expect(fs.existsSync(path.join(root, "canonical-writer.lock"))).toBe(false);
    expect(fs.existsSync(path.join(root, "store.sqlite"))).toBe(true);
  });

  it.each([
    ["missing candidate authorization", { PRG32_BACKEND_CANDIDATE_AUTHORIZATION: undefined }],
    ["production", { NODE_ENV: "production" }],
    ["legacy store fallback", { PRG32_STORE_DATA: "/legacy/data" }],
    ["mDNS", { PRG32_BACKEND_MDNS_ENABLED: "true", PRG32_BACKEND_MDNS_INTERFACE: "lo0" }],
    ["different database", { PRG32_BACKEND_DB: "/tmp/other.sqlite" }]
  ])("rejects unsafe %s configuration", (_label, overrides) => {
    const root = createRoot();
    expect(() => loadConfig(environment(root, overrides))).toThrow();
  });
});
