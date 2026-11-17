import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/env.js";
import { openAuthWriteDatabase } from "../src/db/readonly.js";

const temporaryDirectories: string[] = [];

const AUTH_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password_hash TEXT, role TEXT, last_login TEXT);
  CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, user_id INTEGER, token_hash TEXT, label TEXT, created_at TEXT, last_used TEXT);
  CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE user_groups (user_id INTEGER, group_id INTEGER);
  CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY, email TEXT, token_hash TEXT, expires_at TEXT, used_at TEXT, created_at TEXT);
  CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT);
`;

interface Fixture {
  readonly directory: string;
  readonly root: string;
  readonly operational: string;
  readonly writer: string;
}

function fixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m44-isolation-"));
  temporaryDirectories.push(directory);
  const root = path.join(directory, "disposable");
  fs.mkdirSync(root);
  const operational = path.join(directory, "operational.sqlite");
  const writer = path.join(root, "auth.sqlite");
  for (const databasePath of [operational, writer]) {
    const sqlite = new Database(databasePath);
    sqlite.exec(AUTH_SCHEMA);
    sqlite.close();
  }
  return { directory, root, operational, writer };
}

function config(input: Fixture, overrides: Record<string, string> = {}) {
  return loadConfig({
    PRG32_BACKEND_DB: input.operational,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: input.writer,
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: input.root,
    PRG32_BACKEND_SESSION_SECRET: "test-only-session-secret-that-is-long-enough",
    ...overrides
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("authentication write isolation", () => {
  it.each([
    ["same path", (input: Fixture) => ({ PRG32_BACKEND_AUTH_WRITE_DB: input.operational })],
    ["relative path alias", (input: Fixture) => ({
      PRG32_BACKEND_DB: path.relative(process.cwd(), input.operational),
      PRG32_BACKEND_AUTH_WRITE_DB: path.join(path.relative(process.cwd(), input.directory), "./operational.sqlite")
    })],
    ["absolute path alias", (input: Fixture) => ({
      PRG32_BACKEND_AUTH_WRITE_DB: path.join(input.directory, "disposable", "..", "operational.sqlite")
    })]
  ])("rejects %s", (_label, override) => {
    const input = fixture();
    expect(() => loadConfig({
      ...configEnvironment(input),
      ...override(input)
    })).toThrow("separate");
  });

  it("rejects a symlink alias to the operational database", () => {
    const input = fixture();
    fs.unlinkSync(input.writer);
    fs.symlinkSync(input.operational, input.writer);
    expect(() => openAuthWriteDatabase(config(input))).toThrow("symlink");
  });

  it("rejects a hardlink alias to the operational database", () => {
    const input = fixture();
    fs.unlinkSync(input.writer);
    fs.linkSync(input.operational, input.writer);
    expect(() => openAuthWriteDatabase(config(input))).toThrow("operational");
  });

  it("rejects SQLite URI syntax", () => {
    const input = fixture();
    expect(() => config(input, { PRG32_BACKEND_AUTH_WRITE_DB: `file:${input.writer}?mode=rw` })).toThrow("SQLite URI");
  });

  it("rejects a missing writer database", () => {
    const input = fixture();
    fs.unlinkSync(input.writer);
    expect(() => openAuthWriteDatabase(config(input))).toThrow("unavailable");
  });

  it("rejects a directory instead of a writer database", () => {
    const input = fixture();
    fs.unlinkSync(input.writer);
    fs.mkdirSync(input.writer);
    expect(() => openAuthWriteDatabase(config(input))).toThrow("regular file");
  });

  it("rejects a symlink escape from the disposable root", () => {
    const input = fixture();
    const outside = path.join(input.directory, "outside.sqlite");
    const outsideDb = new Database(outside);
    outsideDb.exec(AUTH_SCHEMA);
    outsideDb.close();
    fs.unlinkSync(input.writer);
    fs.symlinkSync(outside, input.writer);
    expect(() => openAuthWriteDatabase(config(input))).toThrow("symlink");
  });

  it("rejects a regular writer database outside the disposable root", () => {
    const input = fixture();
    const outside = path.join(input.directory, "outside.sqlite");
    const outsideDb = new Database(outside);
    outsideDb.exec(AUTH_SCHEMA);
    outsideDb.close();
    expect(() => openAuthWriteDatabase(config(input, { PRG32_BACKEND_AUTH_WRITE_DB: outside }))).toThrow("reside inside");
  });

  it("rejects a dangling SQLite sidecar symlink", () => {
    const input = fixture();
    fs.symlinkSync(path.join(input.directory, "missing-wal-target"), `${input.writer}-wal`);
    expect(() => openAuthWriteDatabase(config(input))).toThrow("sidecar");
  });

  it("opens a valid disposable database", () => {
    const input = fixture();
    const resource = openAuthWriteDatabase(config(input));
    expect(resource.sqlite.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    resource.close();
  });

  it("keeps the writer disabled by default", () => {
    const input = fixture();
    const disabled = loadConfig({ PRG32_BACKEND_DB: input.operational });
    expect(() => openAuthWriteDatabase(disabled)).toThrow("not enabled");
  });

  it("requires the explicit test-only configuration", () => {
    const input = fixture();
    expect(() => loadConfig({
      PRG32_BACKEND_DB: input.operational,
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: input.writer,
      PRG32_BACKEND_SESSION_SECRET: "secret"
    })).toThrow("DISPOSABLE_ROOT");
  });

  it("rejects a writer without the compatible schema", () => {
    const input = fixture();
    const sqlite = new Database(input.writer);
    sqlite.exec("DROP TABLE store_settings");
    sqlite.close();
    expect(() => openAuthWriteDatabase(config(input))).toThrow("compatible schema");
  });

  it("rejects a target replaced with an operational hardlink before opening", () => {
    const input = fixture();
    fs.unlinkSync(input.writer);
    fs.linkSync(input.operational, input.writer);
    expect(() => openAuthWriteDatabase(config(input))).toThrow("operational");
  });
});

function configEnvironment(input: Fixture): Record<string, string> {
  return {
    PRG32_BACKEND_DB: input.operational,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: input.writer,
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: input.root,
    PRG32_BACKEND_SESSION_SECRET: "test-only-session-secret-that-is-long-enough"
  };
}
