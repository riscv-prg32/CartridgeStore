import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-profile-"));
  roots.push(root);
  const databasePath = path.join(root, "store.sqlite");
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL, external_provider TEXT, created_at TEXT NOT NULL, last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL, last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE user_groups (user_id INTEGER NOT NULL, group_id INTEGER NOT NULL, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, target TEXT NOT NULL, display_backend TEXT NOT NULL, firmware_version TEXT NOT NULL, firmware_git_sha TEXT NOT NULL, game_name TEXT NOT NULL, sample_period_frames INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, dropped_samples INTEGER NOT NULL, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL, user_id INTEGER);
    CREATE TABLE samples (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, frame INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, update_us INTEGER NOT NULL, draw_us INTEGER NOT NULL, present_us INTEGER NOT NULL, frame_us INTEGER NOT NULL, heap_free INTEGER NOT NULL, heap_min_free INTEGER NOT NULL, input_mask INTEGER NOT NULL, fps_x100 INTEGER NOT NULL, upload_queue_depth INTEGER NOT NULL, deadline_missed INTEGER NOT NULL);
    CREATE TABLE scores (id INTEGER PRIMARY KEY, game TEXT NOT NULL, player TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL);
    CREATE TABLE download_events (id INTEGER PRIMARY KEY, game_id TEXT NOT NULL, version TEXT NOT NULL, architecture TEXT NOT NULL, user_id INTEGER, ip_hash TEXT, user_agent TEXT, downloaded_at TEXT NOT NULL);
    INSERT INTO users VALUES (1, 'alice', 'alice@example.test', NULL, 'user', NULL, '2026-01-01', NULL);
    INSERT INTO runs VALUES ('run-1', 'board', 'qemu', '', '1.0', 'sha', 'demo', 1, 100, 200, 0, 100, 'alice', 1);
    INSERT INTO samples VALUES (1, 'run-1', 1, 10, 2, 3, 4, 9, 100, 90, 0, 6000, 0, 0);
  `);
  const token = "prg32_profile_test_token";
  database.prepare("INSERT INTO api_tokens(user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)").run(1, hashApiToken(token), "profile", "2026-01-01");
  database.close();
  return { root, databasePath, token };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Fastify canonical profile and owner/admin run pages", () => {
  it("keeps the public profile summary and protects run data", async () => {
    const test = fixture();
    const app = buildApp({ config: loadConfig({ NODE_ENV: "test", PRG32_BACKEND_DB: test.databasePath, PRG32_BACKEND_STORE_DATA: test.root, PRG32_BACKEND_SESSION_SECRET: "profile-test-secret-long-enough" }), logger: false });
    const profile = await app.inject({ method: "GET", url: "/api/users/alice" });
    expect(profile.statusCode).toBe(200);
    expect(profile.json<{ user: { username: string }; run_count: number; can_view_runs: boolean }>().user.username).toBe("alice");
    expect(profile.json<{ run_count: number }>().run_count).toBe(1);
    expect(profile.json<{ can_view_runs: boolean }>().can_view_runs).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/users/alice/runs" })).statusCode).toBe(403);
    const runs = await app.inject({ method: "GET", url: "/api/users/alice/runs", headers: { authorization: `Bearer ${test.token}` } });
    expect(runs.statusCode).toBe(200);
    expect(runs.json<{ runs: Array<{ run_id: string; p95_frame_us: number }> }>().runs[0]?.run_id).toBe("run-1");
    const detail = await app.inject({ method: "GET", url: "/api/users/alice/runs/run-1", headers: { authorization: `Bearer ${test.token}` } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ summary: { sample_count: number } }>().summary.sample_count).toBe(1);
    await app.close();
  });
});
