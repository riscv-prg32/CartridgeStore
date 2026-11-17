import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/env.js";
import { optionalSecret } from "../src/config/env-values.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function createSecretFile(contents: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-secret-test-"));
  temporaryRoots.push(root);
  const filePath = path.join(root, "secret");
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  return filePath;
}

describe("configuration secret files", () => {
  it("reads Docker-compatible secret files and trims the final newline", () => {
    const filePath = createSecretFile("secret-value\n");

    expect(
      optionalSecret(
        { PRG32_BACKEND_SESSION_SECRET_FILE: filePath },
        "PRG32_BACKEND_SESSION_SECRET",
      ),
    ).toBe("secret-value");
  });

  it("preserves inline secret compatibility when no file is configured", () => {
    expect(
      optionalSecret(
        { PRG32_BACKEND_SESSION_SECRET: "inline-secret" },
        "PRG32_BACKEND_SESSION_SECRET",
      ),
    ).toBe("inline-secret");
  });

  it("rejects ambiguous inline and file configuration", () => {
    const filePath = createSecretFile("file-secret");

    expect(() =>
      optionalSecret(
        {
          PRG32_BACKEND_SESSION_SECRET: "inline-secret",
          PRG32_BACKEND_SESSION_SECRET_FILE: filePath,
        },
        "PRG32_BACKEND_SESSION_SECRET",
      ),
    ).toThrow("cannot both be set");
  });

  it("fails closed for missing and empty secret files", () => {
    const emptyFile = createSecretFile("\n");

    expect(() =>
      optionalSecret(
        { PRG32_BACKEND_SESSION_SECRET_FILE: "/does/not/exist" },
        "PRG32_BACKEND_SESSION_SECRET",
      ),
    ).toThrow("is unavailable");
    expect(() =>
      optionalSecret(
        { PRG32_BACKEND_SESSION_SECRET_FILE: emptyFile },
        "PRG32_BACKEND_SESSION_SECRET",
      ),
    ).toThrow("must not be empty");
  });

  it("wires file-backed auth secrets into the typed backend config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-config-test-"));
    temporaryRoots.push(root);
    const sessionSecret = path.join(root, "session");
    const bootstrapToken = path.join(root, "bootstrap");
    fs.writeFileSync(sessionSecret, "session-file-secret-0123456789012345\n");
    fs.writeFileSync(bootstrapToken, "bootstrap-file-secret-0123456789012345\n");

    const config = loadConfig({
      NODE_ENV: "test",
      PRG32_BACKEND_DB: path.join(root, "shadow.sqlite"),
      PRG32_BACKEND_STORE_DATA: root,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: path.join(root, "auth.sqlite"),
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: root,
      PRG32_BACKEND_SESSION_SECRET_FILE: sessionSecret,
      PRG32_BACKEND_BOOTSTRAP_TOKEN_FILE: bootstrapToken,
      PRG32_BACKEND_SESSION_SECURE: "false",
    });

    expect(config.authSessionSecret).toBe("session-file-secret-0123456789012345");
    expect(config.authBootstrapToken).toBe("bootstrap-file-secret-0123456789012345");
  });
});
