import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { openReadonlyDatabase } from "../src/db/readonly.js";

const roots: string[] = [];
const NOW = 1_700_000_000;

const STATS_SCHEMA = `
  CREATE TABLE runs (run_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, target TEXT NOT NULL, display_backend TEXT NOT NULL DEFAULT '', firmware_version TEXT NOT NULL DEFAULT '', firmware_git_sha TEXT NOT NULL DEFAULT '', game_name TEXT NOT NULL DEFAULT '', sample_period_frames INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL, finished_at INTEGER, dropped_samples INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), submitted_by TEXT NOT NULL DEFAULT '', user_id INTEGER);
  CREATE TABLE samples (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, frame INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, update_us INTEGER NOT NULL, draw_us INTEGER NOT NULL, present_us INTEGER NOT NULL, frame_us INTEGER NOT NULL, heap_free INTEGER NOT NULL, heap_min_free INTEGER NOT NULL, input_mask INTEGER NOT NULL, fps_x100 INTEGER NOT NULL, upload_queue_depth INTEGER NOT NULL, deadline_missed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), UNIQUE(run_id, frame));
  CREATE TABLE scores (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, player TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL DEFAULT '');
  CREATE TABLE download_events (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, architecture TEXT NOT NULL, user_id INTEGER, ip_hash TEXT, user_agent TEXT, downloaded_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX download_events_game_idx ON download_events(game_id, downloaded_at);
  CREATE INDEX download_events_arch_idx ON download_events(architecture);
  CREATE INDEX scores_game_score_idx ON scores(game, score DESC, created_at ASC);
`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m63a-stats-"));
  roots.push(root);
  const storeRoot = path.join(root, "store");
  fs.mkdirSync(storeRoot);
  fs.writeFileSync(path.join(storeRoot, "index.json"), JSON.stringify({
    abi: "prg32-cartridge-store-index-1.0",
    games: {
      "a-game": {
        id: "a-game",
        title: "Alpha Game",
        latest_version: "1.0.0",
        updated_at: "2026-01-03T00:00:00Z",
        versions: { "1.0.0": { architectures: { qemu: { filename: "unused.prg32" } } } }
      }
    }
  }));
  const databasePath = path.join(root, "stats.sqlite");
  const database = new Database(databasePath);
  database.exec(STATS_SCHEMA);
  database.transaction(() => {
    database.prepare("INSERT INTO download_events(game_id, version, architecture, downloaded_at) VALUES (?, ?, ?, ?)").run("a-game", "1.0.0", "esp32c6", "2026-01-01 00:00:00");
    database.prepare("INSERT INTO download_events(game_id, version, architecture, downloaded_at) VALUES (?, ?, ?, ?)").run("a-game", "1.0.0", "qemu", "2026-01-01 12:00:00");
    database.prepare("INSERT INTO download_events(game_id, version, architecture, downloaded_at) VALUES (?, ?, ?, ?)").run("a-game", "1.0.0", "esp32c6", "2026-01-02 00:00:00");
    database.prepare("INSERT INTO download_events(game_id, version, architecture, downloaded_at) VALUES (?, ?, ?, ?)").run("b-game", "2.0.0", "qemu", "2026-01-08 00:00:00");
    database.prepare("INSERT INTO download_events(game_id, version, architecture, downloaded_at) VALUES (?, ?, ?, ?)").run("b-game", "2.0.0", "esp32c6", "2026-02-01 00:00:00");
    database.prepare("INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES (?, ?, ?, ?, ?)").run("a-game", "alice", 100, 1700000010, "anonymous");
    database.prepare("INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES (?, ?, ?, ?, ?)").run("b-game", "bob", 100, 1700000000, "anonymous");
    database.prepare("INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES (?, ?, ?, ?, ?)").run("a-game", "carol", 50, 1700000020, "tester");
    database.prepare("INSERT INTO runs(run_id, board_id, target, started_at, created_at, finished_at) VALUES (?, 'board', 'qemu', ?, ?, ?)").run("run-current", 1700000000000, 1700000000, null);
    database.prepare("INSERT INTO runs(run_id, board_id, target, started_at, created_at, finished_at) VALUES (?, 'board', 'qemu', ?, ?, ?)").run("run-boundary", 1699395200000, 1699395200, 1700000100);
    database.prepare("INSERT INTO runs(run_id, board_id, target, started_at, created_at, finished_at) VALUES (?, 'board', 'qemu', ?, ?, ?)").run("run-old", 1699395199000, 1699395199, null);
    database.prepare("INSERT INTO runs(run_id, board_id, target, started_at, created_at, finished_at, user_id) VALUES (?, 'board', 'qemu', ?, ?, ?, ?)").run("run-owned", 1699999900000, 1699999900, null, 7);
  })();
  database.close();
  const shadow = path.join(root, "shadow.sqlite");
  fs.writeFileSync(shadow, "shadow");
  const app = buildApp({ config: loadConfig({ PRG32_BACKEND_DB: databasePath, PRG32_BACKEND_STORE_DATA: storeRoot, PRG32_BACKEND_SESSION_SECURE: "false" }), logger: false, nowSeconds: () => NOW });
  return { app, root, storeRoot, databasePath, shadow };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("statistics API parity", () => {
  it("matches deterministic fixtures for all four public endpoints", async () => {
    const test = fixture();
    const cases: Array<[string, unknown]> = [
      ["/api/stats/downloads", {
        series: [
          { date: "2026-01-01", downloads: 2 }, { date: "2026-01-02", downloads: 1 },
          { date: "2026-01-08", downloads: 1 }, { date: "2026-02-01", downloads: 1 }
        ],
        top_games: [
          { id: "a-game", title: "Alpha Game", downloads: 3, last_published: "2026-01-03T00:00:00Z" },
          { id: "b-game", title: "b-game", downloads: 2, last_published: "" }
        ],
        total: 5
      }],
      ["/api/stats/downloads?granularity=week", {
        series: [
          { date: "2025-12-29", downloads: 3 }, { date: "2026-01-05", downloads: 1 }, { date: "2026-01-26", downloads: 1 }
        ],
        top_games: [
          { id: "a-game", title: "Alpha Game", downloads: 3, last_published: "2026-01-03T00:00:00Z" },
          { id: "b-game", title: "b-game", downloads: 2, last_published: "" }
        ],
        total: 5
      }],
      ["/api/stats/downloads?granularity=month&limit=1", {
        series: [{ date: "2026-02-01", downloads: 1 }],
        top_games: [
          { id: "a-game", title: "Alpha Game", downloads: 3, last_published: "2026-01-03T00:00:00Z" },
          { id: "b-game", title: "b-game", downloads: 2, last_published: "" }
        ],
        total: 5
      }],
      ["/api/stats/downloads/a-game?since=2026-01-01&until=2026-01-02", {
        id: "a-game", total: 3,
        architectures: [{ architecture: "esp32c6", downloads: 2 }, { architecture: "qemu", downloads: 1 }],
        series: [{ date: "2026-01-01", downloads: 2 }, { date: "2026-01-02", downloads: 1 }]
      }],
      ["/api/stats/downloads/unknown-game", { id: "unknown-game", total: 0, architectures: [], series: [] }],
      ["/api/stats/scores", { scores: [
        { game: "b-game", player: "bob", score: 100, created_at: 1700000000, submitted_by: "anonymous" },
        { game: "a-game", player: "alice", score: 100, created_at: 1700000010, submitted_by: "anonymous" },
        { game: "a-game", player: "carol", score: 50, created_at: 1700000020, submitted_by: "tester" }
      ] }],
      ["/api/stats/scores?limit=1", { scores: [{ game: "b-game", player: "bob", score: 100, created_at: 1700000000, submitted_by: "anonymous" }] }],
      ["/api/stats/runs", { total: 4, finished: 1, active_last_7_days: 3 }]
    ];
    for (const [url, expected] of cases) {
      const response = await test.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.json(), url).toEqual(expected);
    }
    await test.app.close();
  });

  it("preserves compatibility fallback semantics for invalid filters and bounds", async () => {
    const test = fixture();
    const invalid = await test.app.inject({ method: "GET", url: "/api/stats/downloads?granularity=hour&since=bad&until=bad&limit=invalid" });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json<{ series: unknown[] }>().series).toHaveLength(4);
    const lower = await test.app.inject({ method: "GET", url: "/api/stats/downloads?granularity=MONTH&limit=2" });
    expect(lower.statusCode).toBe(200);
    expect(lower.json<{ series: unknown[] }>().series).toEqual([{ date: "2026-01-01", downloads: 4 }, { date: "2026-02-01", downloads: 1 }]);
    const injected = await test.app.inject({ method: "GET", url: "/api/stats/downloads/a-game%27%20OR%201%3D1%20--?limit=365" });
    expect(injected.statusCode).toBe(200);
    expect(injected.json()).toEqual({ id: "a-game' OR 1=1 --", total: 0, architectures: [], series: [] });
    const html = await test.app.inject({ method: "GET", url: "/api/stats/downloads/%3Cscript%3Ealert(1)%3C%2Fscript%3E?unexpected=ignored" });
    expect(html.json()).toEqual({ id: "<script>alert(1)</script>", total: 0, architectures: [], series: [] });
    const unicode = await test.app.inject({ method: "GET", url: "/api/stats/downloads/%CF%80-game" });
    expect(unicode.json()).toEqual({ id: "π-game", total: 0, architectures: [], series: [] });
    await test.app.close();
  });

  it("returns compatibility zero aggregates for an empty database", async () => {
    const test = fixture();
    const database = new Database(test.databasePath);
    database.exec("DELETE FROM download_events; DELETE FROM scores; DELETE FROM runs;");
    database.close();
    expect((await test.app.inject({ method: "GET", url: "/api/stats/downloads" })).json()).toEqual({ series: [], top_games: [], total: 0 });
    expect((await test.app.inject({ method: "GET", url: "/api/stats/downloads/unknown" })).json()).toEqual({ id: "unknown", total: 0, architectures: [], series: [] });
    expect((await test.app.inject({ method: "GET", url: "/api/stats/scores" })).json()).toEqual({ scores: [] });
    expect((await test.app.inject({ method: "GET", url: "/api/stats/runs" })).json()).toEqual({ total: 0, finished: 0, active_last_7_days: 0 });
    await test.app.close();
  });

  it("uses a query-only SQLite connection and performs no schema or data mutation", async () => {
    const test = fixture();
    const before = fs.readFileSync(test.databasePath);
    const beforeEntries = fs.readdirSync(test.root).sort();
    for (const url of ["/api/stats/downloads", "/api/stats/downloads/a-game", "/api/stats/scores", "/api/stats/runs"]) {
      expect((await test.app.inject({ method: "GET", url })).statusCode).toBe(200);
    }
    await test.app.close();
    const after = fs.readFileSync(test.databasePath);
    expect(crypto.createHash("sha256").update(after).digest("hex")).toBe(crypto.createHash("sha256").update(before).digest("hex"));
    expect(fs.readdirSync(test.root).sort()).toEqual(beforeEntries);

    const config = loadConfig({ PRG32_BACKEND_DB: test.databasePath, PRG32_BACKEND_STORE_DATA: test.storeRoot });
    const readonly = openReadonlyDatabase(config);
    expect(readonly.sqlite.pragma("query_only", { simple: true })).toBe(1);
    expect(() => readonly.sqlite.exec("CREATE TABLE forbidden_stats_write(id INTEGER)"))
      .toThrow(/readonly|read-only|query_only/i);
    expect(() => readonly.sqlite.exec("DELETE FROM scores"))
      .toThrow(/readonly|read-only|query_only/i);
    readonly.close();
  });

  it("records the current query-plan trade-offs without changing indexes", async () => {
    const test = fixture();
    const database = new Database(test.databasePath, { readonly: true });
    const gamePlan = database.prepare("EXPLAIN QUERY PLAN SELECT architecture, COUNT(*) AS downloads FROM download_events WHERE game_id = ? GROUP BY architecture ORDER BY downloads DESC, architecture ASC").all("a-game") as Array<{ detail: string }>;
    const scorePlan = database.prepare("EXPLAIN QUERY PLAN SELECT game, player, score, created_at, submitted_by FROM scores ORDER BY score DESC, created_at ASC LIMIT ?").all(100) as Array<{ detail: string }>;
    const runPlan = database.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS count FROM runs WHERE created_at >= ?").all(NOW - 604800) as Array<{ detail: string }>;
    expect(gamePlan.some((row) => row.detail.includes("download_events_game_idx"))).toBe(true);
    expect(scorePlan.some((row) => row.detail.includes("SCAN scores"))).toBe(true);
    expect(runPlan.some((row) => row.detail.includes("SCAN runs"))).toBe(true);
    database.close();
    await test.app.close();
  });
});
