import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { generateRegistryDocument } from "../src/secrets/registry.js";
import { initializeOperationalStorage } from "../src/storage-v2/database.js";

function fixture(): { root: string; keyPath: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m534-operational-"));
  const root = path.join(parent, "canonical");
  const keyPath = path.join(parent, "secret-keys.json");
  const storage = initializeOperationalStorage(root, "operational-bootstrap-authorization-01234567890123456789");
  storage.close();
  fs.writeFileSync(keyPath, generateRegistryDocument("test-key"), { mode: 0o600 });
  return { root, keyPath };
}

function environment(input: ReturnType<typeof fixture>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PRG32_BACKEND_HOST: "127.0.0.1",
    PRG32_BACKEND_PORT: "5080",
    PRG32_BACKEND_DB: path.join(input.root, "store.sqlite"),
    PRG32_BACKEND_STORE_DATA: input.root,
    PRG32_BACKEND_CATALOG_READ_MODE: "canonical-operational",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: input.root,
    PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: "operational-read-authorization-01234567890123456789",
    PRG32_BACKEND_CANONICAL_WORKFLOW_MODE: "operational",
    PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION: "operational-write-authorization-01234567890123456789",
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "operational",
    PRG32_BACKEND_AUTH_WRITE_DB: path.join(input.root, "store.sqlite"),
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: input.root,
    PRG32_BACKEND_SESSION_SECRET: "operational-session-secret-01234567890123456789",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: "operational-bootstrap-token-01234567890123456789",
    PRG32_BACKEND_SESSION_SECURE: "true",
    PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN: "https://store.prg32.test",
    PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN: "https://api.prg32.test",
    PRG32_BACKEND_OIDC_PUBLIC_ORIGIN: "https://api.prg32.test",
    PRG32_BACKEND_TRUST_PROXY: "true",
    PRG32_BACKEND_MDNS_ENABLED: "false",
    PRG32_BACKEND_SECRET_ENCRYPTION_ENABLED: "true",
    PRG32_BACKEND_SECRET_KEY_REGISTRY: input.keyPath,
    PRG32_BACKEND_BACKUP_ENABLED: "false"
  };
}

describe("canonical operational runtime", () => {
  it("boots only from an explicit canonical root and holds the writer lease", async () => {
    const input = fixture();
    const config = loadConfig(environment(input));
    const app = buildApp({ config, logger: false });
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, resources: { canonical_storage: "available", writer_lease: "held" } });
    await app.close();
  });

  it("rejects operational mode when a legacy fallback or proxy trust is missing", () => {
    const input = fixture();
    expect(() => loadConfig({ ...environment(input), PRG32_BACKEND_TRUST_PROXY: "false" })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...environment(input), PRG32_STORE_DATA: "/legacy" })).toThrow(/legacy database/);
  });
});
