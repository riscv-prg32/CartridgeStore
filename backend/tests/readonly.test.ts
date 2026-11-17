import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/env.js";
import { inspectSchema, REQUIRED_TABLES } from "../src/db/schema-inspection.js";
import { openReadonlyDatabase } from "../src/db/readonly.js";

const temporaryDirectories: string[] = [];

function createFixtureDatabase(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-backend-test-"));
  temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "store.sqlite");
  const sqlite = new Database(databasePath);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, target TEXT NOT NULL, display_backend TEXT NOT NULL DEFAULT '', firmware_version TEXT NOT NULL DEFAULT '', firmware_git_sha TEXT NOT NULL DEFAULT '', game_name TEXT NOT NULL DEFAULT '', sample_period_frames INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL, finished_at INTEGER, dropped_samples INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), submitted_by TEXT NOT NULL DEFAULT '', user_id INTEGER REFERENCES users(id));
    CREATE TABLE samples (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, frame INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, update_us INTEGER NOT NULL, draw_us INTEGER NOT NULL, present_us INTEGER NOT NULL, frame_us INTEGER NOT NULL, heap_free INTEGER NOT NULL, heap_min_free INTEGER NOT NULL, input_mask INTEGER NOT NULL, fps_x100 INTEGER NOT NULL, upload_queue_depth INTEGER NOT NULL, deadline_missed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), UNIQUE(run_id, frame));
    CREATE TABLE scores (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, player TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL DEFAULT '');
    CREATE INDEX scores_game_score_idx ON scores(game, score DESC, created_at ASC);
    CREATE TABLE download_events (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, architecture TEXT NOT NULL, user_id INTEGER, ip_hash TEXT, user_agent TEXT, downloaded_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE cartridge_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_by TEXT NOT NULL DEFAULT '', reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT NOT NULL DEFAULT '', pending_dir TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL, architectures_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT);
  `);
  sqlite.close();
  return databasePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("read-only SQLite foundation", () => {
  it("opens an existing fixture without creating a missing database", () => {
    const missing = path.join(os.tmpdir(), "prg32-backend-missing", "store.sqlite");
    expect(() => openReadonlyDatabase(loadConfig({ PRG32_BACKEND_DB: missing }))).toThrow(
      "unavailable"
    );
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("rejects direct writes at the SQLite connection boundary", () => {
    const databasePath = createFixtureDatabase();
    const resource = openReadonlyDatabase(loadConfig({ PRG32_BACKEND_DB: databasePath }));
    expect(() => resource.sqlite.prepare("CREATE TABLE forbidden (id INTEGER)").run()).toThrow();
    expect(() => resource.sqlite.prepare("INSERT INTO store_settings(key, value) VALUES ('x', 'y')").run()).toThrow();
    resource.close();
  });

  it("maps every current table and preserves the representative columns", () => {
    const databasePath = createFixtureDatabase();
    const resource = openReadonlyDatabase(loadConfig({ PRG32_BACKEND_DB: databasePath }));
    const snapshot = inspectSchema(resource.sqlite);
    expect(snapshot.tables.map((table) => table.name)).toEqual([...REQUIRED_TABLES]);
    const runs = snapshot.tables.find((table) => table.name === "runs");
    expect(runs?.columns.map((column) => column.name)).toContain("user_id");
    expect(runs?.columns.find((column) => column.name === "started_at")?.type).toBe("INTEGER");
    const samples = snapshot.tables.find((table) => table.name === "samples");
    expect(samples?.indexes.map((index) => index.name)).toContain("sqlite_autoindex_samples_1");
    resource.close();
  });
});
