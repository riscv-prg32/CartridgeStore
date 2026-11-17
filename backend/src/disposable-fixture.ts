import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const authDatabasePath = process.env.PRG32_WRITER_AUTH_DB ?? "/writer-data/auth.sqlite";
const shadowDatabasePath = process.env.PRG32_WRITER_SHADOW_DB ?? "/writer-shadow/shadow.sqlite";
const storeDataDirectory = process.env.PRG32_WRITER_STORE_DATA ?? "/writer-store";

const AUTH_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
  CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
  CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
  CREATE TABLE IF NOT EXISTS registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cartridge_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_by TEXT NOT NULL DEFAULT '', reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT NOT NULL DEFAULT '', pending_dir TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL, architectures_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT);
  CREATE INDEX IF NOT EXISTS cartridge_submissions_status_idx ON cartridge_submissions(status, created_at);
  CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, target TEXT NOT NULL, display_backend TEXT NOT NULL DEFAULT '', firmware_version TEXT NOT NULL DEFAULT '', firmware_git_sha TEXT NOT NULL DEFAULT '', game_name TEXT NOT NULL DEFAULT '', sample_period_frames INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL, finished_at INTEGER, dropped_samples INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), submitted_by TEXT NOT NULL DEFAULT '', user_id INTEGER REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, frame INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, update_us INTEGER NOT NULL, draw_us INTEGER NOT NULL, present_us INTEGER NOT NULL, frame_us INTEGER NOT NULL, heap_free INTEGER NOT NULL, heap_min_free INTEGER NOT NULL, input_mask INTEGER NOT NULL, fps_x100 INTEGER NOT NULL, upload_queue_depth INTEGER NOT NULL, deadline_missed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), UNIQUE(run_id, frame));
  CREATE INDEX IF NOT EXISTS samples_run_frame_idx ON samples(run_id, frame);
  CREATE INDEX IF NOT EXISTS samples_run_frame_time_idx ON samples(run_id, frame_us);
  CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, player TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL DEFAULT '');
  CREATE INDEX IF NOT EXISTS scores_game_score_idx ON scores(game, score DESC, created_at ASC);
  CREATE TABLE IF NOT EXISTS download_events (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, architecture TEXT NOT NULL, user_id INTEGER, ip_hash TEXT, user_agent TEXT, downloaded_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS download_events_game_idx ON download_events(game_id, downloaded_at);
  CREATE INDEX IF NOT EXISTS download_events_arch_idx ON download_events(architecture);
  INSERT OR IGNORE INTO groups(name) VALUES ('editors');
`;

function prepareDatabase(databasePath: string): void {
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const sqlite = new Database(databasePath);
  sqlite.exec(AUTH_SCHEMA);
  sqlite.close();
  fs.chmodSync(databasePath, 0o600);
}

if (path.resolve(authDatabasePath) === path.resolve(shadowDatabasePath)) {
  throw new Error("writer fixture databases must be separate");
}

fs.mkdirSync(storeDataDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(storeDataDirectory, 0o700);
prepareDatabase(authDatabasePath);
prepareDatabase(shadowDatabasePath);
