import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";

import { parseLegacyConfiguredUsers, lookupApiToken, hashApiToken } from "../src/auth/tokens.js";
import { verifyWerkzeugPasswordHash } from "../src/auth/password.js";
import { compareSchemaSnapshots, assertSchemaCompatible } from "../src/compatibility/schema.js";
import { inventoryCartridgeStore } from "../src/compatibility/cartridge-inventory.js";
import {
  decodeStoredJson,
  encodePythonJson,
  principalAsPythonDict,
  projectSqliteRow
} from "../src/compatibility/serialization.js";
import { inspectSchema } from "../src/db/schema-inspection.js";
import type { SchemaSnapshot } from "../src/db/schema-inspection.js";
import { schema } from "../src/db/schema.js";

type JsonObject = Record<string, unknown>;
type Fixture = JsonObject & { [key: string]: unknown };

const input = loadJson("compatibility-input.json") as Fixture;
const oracle = loadJson("python-compatibility-oracle.json") as Fixture;
const expectedSchema = loadJson("python-schema-snapshot.json") as SchemaSnapshot;
const temporaryDirectories: string[] = [];

function loadJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;
}

function rows(table: string): JsonObject[] {
  return input[table] as JsonObject[];
}

function createFixtureDatabase(): { databasePath: string; sqlite: Database.Database } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m21-backend-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "store.sqlite");
  const sqlite = new Database(databasePath);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE INDEX users_external_idx ON users(external_provider, external_id);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE INDEX api_tokens_user_idx ON api_tokens(user_id);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE INDEX registration_tokens_email_idx ON registration_tokens(email, used_at, expires_at);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, target TEXT NOT NULL, display_backend TEXT NOT NULL DEFAULT '', firmware_version TEXT NOT NULL DEFAULT '', firmware_git_sha TEXT NOT NULL DEFAULT '', game_name TEXT NOT NULL DEFAULT '', sample_period_frames INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL, finished_at INTEGER, dropped_samples INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), submitted_by TEXT NOT NULL DEFAULT '', user_id INTEGER REFERENCES users(id));
    CREATE TABLE samples (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, frame INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, update_us INTEGER NOT NULL, draw_us INTEGER NOT NULL, present_us INTEGER NOT NULL, frame_us INTEGER NOT NULL, heap_free INTEGER NOT NULL, heap_min_free INTEGER NOT NULL, input_mask INTEGER NOT NULL, fps_x100 INTEGER NOT NULL, upload_queue_depth INTEGER NOT NULL, deadline_missed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), UNIQUE(run_id, frame));
    CREATE INDEX samples_run_frame_idx ON samples(run_id, frame);
    CREATE INDEX samples_run_frame_time_idx ON samples(run_id, frame_us);
    CREATE TABLE scores (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, player TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL DEFAULT '');
    CREATE INDEX scores_game_score_idx ON scores(game, score DESC, created_at ASC);
    CREATE TABLE download_events (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, architecture TEXT NOT NULL, user_id INTEGER, ip_hash TEXT, user_agent TEXT, downloaded_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX download_events_game_idx ON download_events(game_id, downloaded_at);
    CREATE INDEX download_events_arch_idx ON download_events(architecture);
    CREATE TABLE cartridge_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_by TEXT NOT NULL DEFAULT '', reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT NOT NULL DEFAULT '', pending_dir TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL, architectures_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT);
    CREATE INDEX cartridge_submissions_status_idx ON cartridge_submissions(status, created_at);
  `);
  for (const table of ["users", "groups", "user_groups", "api_tokens", "registration_tokens", "store_settings", "runs", "samples", "scores", "download_events", "cartridge_submissions"]) {
    const tableRows = rows(table);
    if (tableRows.length === 0) continue;
    const columns = Object.keys(tableRows[0]);
    const placeholders = columns.map(() => "?").join(",");
    const statement = sqlite.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`);
    for (const row of tableRows) {
      statement.run(...columns.map((column) => row[column]));
    }
  }
  return { databasePath, sqlite };
}

function oracleRows(table: string): JsonObject[] {
  return (oracle.rows as JsonObject)[table] as JsonObject[];
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("data and serialization compatibility gate", () => {
  it("matches the authoritative SQLite schema snapshot", () => {
    const { sqlite } = createFixtureDatabase();
    const actual = inspectSchema(sqlite);
    expect(compareSchemaSnapshots(expectedSchema, actual)).toEqual([]);
    assertSchemaCompatible(expectedSchema, actual);
    sqlite.close();
  });

  it("keeps the Drizzle table/column mapping complete", () => {
    const mapped = Object.values(schema).map((table) => {
      const config = getTableConfig(table);
      return {
        name: config.name,
        columns: config.columns.map((column) => column.name)
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const expected = expectedSchema.tables.map((table) => ({
      name: table.name,
      columns: [
        ...table.columns.map((column) => column.name),
        ...(table.name === "users" ? ["disabled_at"] : [])
      ]
    })).sort((left, right) => left.name.localeCompare(right.name));
    expect(mapped).toEqual(expected);
  });

  it("preserves SQLite rows and Python-compatible JSON serialization", () => {
    const { sqlite } = createFixtureDatabase();
    const orderBy: Record<string, string> = {
      runs: "run_id",
      store_settings: "key",
      user_groups: "user_id, group_id"
    };
    for (const table of ["api_tokens", "cartridge_submissions", "download_events", "groups", "registration_tokens", "runs", "samples", "scores", "store_settings", "user_groups", "users"]) {
      const actual = sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy[table] ?? "id"}`).all() as JsonObject[];
      expect(actual).toEqual(oracleRows(table));
    }

    const submission = sqlite.prepare("SELECT metadata_json, architectures_json FROM cartridge_submissions WHERE id = 1").get() as JsonObject;
    const metadata = decodeStoredJson(submission.metadata_json as string);
    const architectures = decodeStoredJson(submission.architectures_json as string);
    expect({ metadata, architectures }).toEqual(oracle.json);
    expect(encodePythonJson(metadata)).toBe(rows("cartridge_submissions")[0].metadata_json);
    expect(encodePythonJson(architectures)).toBe(rows("cartridge_submissions")[0].architectures_json);

    const projected = projectSqliteRow(oracleRows("users")[0], ["id", "username", "missing"]);
    expect(projected).toEqual({ id: 1, username: "compat-publisher", missing: null });
    expect(principalAsPythonDict({ id: 1, name: "compat-publisher", email: "publisher@example.test", role: "publisher", groups: ["editors"], authenticated: true })).toEqual(oracle.principal);
    sqlite.close();
  });

  it("recognizes Werkzeug hashes and preserves token lookup semantics", () => {
    const { sqlite } = createFixtureDatabase();
    const users = rows("users");
    const passwordCases = input.password_cases as Record<string, string>;
    for (const user of users) {
      const expectedUser = oracle.password_results as Record<string, Record<string, unknown>>;
      const username = user.username as string;
      expect(verifyWerkzeugPasswordHash(user.password_hash as string, passwordCases.valid)).toMatchObject({ status: expectedUser[`${username}:valid`] ? "valid" : "invalid" });
      expect(verifyWerkzeugPasswordHash(user.password_hash as string, passwordCases.invalid)).toMatchObject({ status: expectedUser[`${username}:invalid`] ? "valid" : "invalid" });
    }
    expect(verifyWerkzeugPasswordHash("md5$salt$digest", "password").status).toBe("unsupported");

    const tokenCases = input.token_cases as Record<string, string>;
    const tokenHashes = oracle.token_hashes as Record<string, string>;
    expect(hashApiToken(tokenCases.api)).toBe(tokenHashes.api);
    expect(hashApiToken(tokenCases.registration)).toBe(tokenHashes.registration);
    const lookup = lookupApiToken(sqlite, tokenCases.api);
    expect(lookup).toMatchObject({ tokenHash: tokenHashes.api, label: "synthetic firmware", lastUsed: null, owner: { id: 1, username: "compat-publisher", email: "publisher@example.test", role: "publisher", groups: ["editors"] } });
    expect(lookupApiToken(sqlite, "wrong-token")).toBeNull();
    expect(sqlite.prepare("SELECT last_used FROM api_tokens WHERE id = 1").get()).toEqual({ last_used: null });

    expect(parseLegacyConfiguredUsers([{ name: "firmware", role: "reader", token: "legacy-token" }])).toEqual([{ name: "firmware", role: "reader", token: "legacy-token" }]);
    expect(parseLegacyConfiguredUsers({ "legacy-token": "reader" })).toEqual([{ name: "reader", role: "reader", token: "legacy-token" }]);
    sqlite.close();
  });

  it("interprets the cartridge filesystem read-only and rejects unsafe paths", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m21-catalog-"));
    temporaryDirectories.push(directory);
    const catalog = JSON.parse(JSON.stringify(input.catalog_index)) as JsonObject;
    const games = catalog.games as JsonObject;
    const game = games["compat-game"] as JsonObject;
    const version = (game.versions as JsonObject)["1.0.0"] as JsonObject;
    const variant = ((version.architectures as JsonObject)["esp32c6"] as JsonObject);
    fs.mkdirSync(path.join(directory, "cartridges/compat-game/1.0.0"), { recursive: true });
    fs.writeFileSync(path.join(directory, variant.filename as string), Buffer.from(input.catalog_binary_hex as string, "hex"));
    fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify(catalog));
    const before = fs.readdirSync(directory).sort();
    const inventory = inventoryCartridgeStore(directory);
    expect(inventory.issues).toEqual([]);
    expect(inventory.games[0]?.variants[0]).toMatchObject({ pathSafe: true, exists: true, size: 6, hashMatches: true });
    expect(fs.readdirSync(directory).sort()).toEqual(before);

    variant.filename = "../outside.prg32";
    fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify(catalog));
    const unsafe = inventoryCartridgeStore(directory);
    expect(unsafe.issues).toContain("unsafe variant path compat-game/1.0.0/esp32c6");
    expect(unsafe.games[0]?.variants[0]).toMatchObject({ pathSafe: false, exists: false, size: null, sha256: null });
  });
});
