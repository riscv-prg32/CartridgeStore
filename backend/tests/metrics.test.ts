import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { MetricsService } from "../src/metrics/service.js";

const roots: string[] = [];
const BOOTSTRAP = "metrics-bootstrap-token-1234567890";

const METRICS_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
  CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
  CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
  CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE runs (run_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, target TEXT NOT NULL, display_backend TEXT NOT NULL DEFAULT '', firmware_version TEXT NOT NULL DEFAULT '', firmware_git_sha TEXT NOT NULL DEFAULT '', game_name TEXT NOT NULL DEFAULT '', sample_period_frames INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL, finished_at INTEGER, dropped_samples INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), submitted_by TEXT NOT NULL DEFAULT '', user_id INTEGER REFERENCES users(id));
  CREATE TABLE samples (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, frame INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, update_us INTEGER NOT NULL, draw_us INTEGER NOT NULL, present_us INTEGER NOT NULL, frame_us INTEGER NOT NULL, heap_free INTEGER NOT NULL, heap_min_free INTEGER NOT NULL, input_mask INTEGER NOT NULL, fps_x100 INTEGER NOT NULL, upload_queue_depth INTEGER NOT NULL, deadline_missed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), UNIQUE(run_id, frame));
  CREATE INDEX samples_run_frame_idx ON samples(run_id, frame);
  CREATE INDEX samples_run_frame_time_idx ON samples(run_id, frame_us);
  INSERT INTO groups(name) VALUES ('editors');
`;

function fixture(overrides: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m61-metrics-"));
  roots.push(root);
  const authRoot = path.join(root, "auth");
  const storeRoot = path.join(root, "store");
  fs.mkdirSync(authRoot); fs.mkdirSync(storeRoot);
  const databasePath = path.join(authRoot, "auth.sqlite");
  const shadowPath = path.join(root, "shadow.sqlite");
  const database = new Database(databasePath); database.exec(METRICS_SCHEMA); database.close();
  fs.writeFileSync(shadowPath, Buffer.from("shadow"));
  const app = buildApp({ config: loadConfig({
    PRG32_BACKEND_DB: shadowPath,
    PRG32_BACKEND_STORE_DATA: storeRoot,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: databasePath,
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: authRoot,
    PRG32_BACKEND_METRICS_WRITE_ENABLED: "true",
    PRG32_BACKEND_METRICS_WRITE_MODE: "test",
    PRG32_BACKEND_METRICS_DISPOSABLE_ROOT: authRoot,
    PRG32_BACKEND_SESSION_SECRET: "metrics-session-secret-1234567890",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false",
    ...overrides
  }), logger: false });
  return { app, root, authRoot, databasePath, storeRoot };
}

function header(response: { headers: Record<string, string | string[] | undefined> }, key: string): string {
  const value = response.headers[key]; return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function adminSession(app: ReturnType<typeof buildApp>): Promise<{ cookie: string }> {
  const boot = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": BOOTSTRAP }, payload: { username: "metrics-admin", email: "metrics-admin@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
  return { cookie: header(boot, "set-cookie").split(";", 1)[0] ?? "" };
}

function sample(frame: number) {
  return { frame, timestamp_ms: 1000 + frame, update_us: 10, draw_us: 20, present_us: 30, frame_us: 60, heap_free: 100, heap_min_free: 90, input_mask: 0, fps_x100: 6000, upload_queue_depth: 0, deadline_missed: frame === 2 };
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("metrics, runs, and samples", () => {
  it("accepts firmware-shaped anonymous ingestion without auth or CSRF and preserves NULL ownership", async () => {
    const test = fixture();
    const run = await test.app.inject({ method: "POST", url: "/api/runs", payload: { run_id: "firmware-run", board_id: "prg32-board", target: "qemu", display_backend: "headless", firmware_version: "dev", firmware_git_sha: "unknown", game_name: "metrics-game", sample_period_frames: 1, started_ms: 1000 } });
    expect(run.statusCode).toBe(200); expect(run.json()).toEqual({ ok: true, run_id: "firmware-run" });
    const batch = await test.app.inject({ method: "POST", url: "/api/metrics/batch", payload: { run_id: "firmware-run", samples: [sample(1), sample(2)], dropped_samples: 3 } });
    expect(batch.statusCode).toBe(200); expect(batch.json()).toMatchObject({ ok: true, inserted: 2, received: 2 });
    const duplicate = await test.app.inject({ method: "POST", url: "/api/metrics/batch", payload: { run_id: "firmware-run", samples: [sample(1), sample(2)] } });
    expect(duplicate.json()).toMatchObject({ ok: true, inserted: 0, received: 2 });
    const finish = await test.app.inject({ method: "POST", url: "/api/runs/firmware-run/finish", payload: { finished_ms: 2000, dropped_samples: 5 } });
    expect(finish.statusCode).toBe(200);
    const database = new Database(test.databasePath, { readonly: true });
    expect(database.prepare("SELECT user_id, started_at, finished_at, dropped_samples FROM runs WHERE run_id = ?").get("firmware-run")).toMatchObject({ user_id: null, started_at: 1000, finished_at: 2000, dropped_samples: 5 });
    expect((database.prepare("SELECT COUNT(*) AS count FROM samples WHERE run_id = ?").get("firmware-run") as { count: number }).count).toBe(2);
    database.close();
    await test.app.close();
  });

  it("preserves read authorization, detail, CSV, Markdown, and JSON export contracts", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    await test.app.inject({ method: "POST", url: "/api/runs", payload: { run_id: "private-run", board_id: "board", target: "qemu" } });
    await test.app.inject({ method: "POST", url: "/api/metrics/batch", payload: { run_id: "private-run", samples: [sample(1)] } });
    expect((await test.app.inject({ method: "GET", url: "/api/runs" })).json()).toEqual([]);
    expect((await test.app.inject({ method: "GET", url: "/api/runs/private-run" })).json()).toEqual({ ok: false, error: "forbidden" });
    const detail = await test.app.inject({ method: "GET", url: "/api/runs/private-run", headers: { cookie: admin.cookie } });
    expect(detail.statusCode).toBe(200); expect(detail.json()).toMatchObject({ ok: true, run: { run_id: "private-run", user_id: null }, summary: { sample_count: 1, frame_us_avg: 60 } });
    const csv = await test.app.inject({ method: "GET", url: "/api/runs/private-run/samples.csv", headers: { cookie: admin.cookie } });
    expect(csv.statusCode).toBe(200); expect(csv.body).toContain("frame,timestamp_ms,update_us");
    const markdown = await test.app.inject({ method: "GET", url: "/api/runs/private-run/report.md", headers: { cookie: admin.cookie } });
    expect(markdown.statusCode).toBe(200); expect(markdown.body).toContain("# PRG32 Metrics Report");
    const json = await test.app.inject({ method: "GET", url: "/api/runs/private-run?format=json", headers: { cookie: admin.cookie } });
    expect(json.statusCode).toBe(200); expect(json.headers["content-disposition"]).toContain("run-private-run.json"); expect(json.json()).toMatchObject({ ok: true, samples: [expect.objectContaining({ frame: 1 })] });
    const database = new Database(test.databasePath);
    database.prepare("INSERT INTO users(id, username, email, role) VALUES (?, ?, ?, ?), (?, ?, ?, ?)").run(2, "owner", "owner@example.test", "user", 3, "other", "other@example.test", "user");
    const ownerToken = "prg32_owner-metrics-token";
    const otherToken = "prg32_other-metrics-token";
    database.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?), (?, ?, ?)").run(2, hashApiToken(ownerToken), "owner", 3, hashApiToken(otherToken), "other");
    database.close();
    await test.app.inject({ method: "POST", url: "/api/runs", headers: { authorization: `Bearer ${ownerToken}` }, payload: { run_id: "owned-run", board_id: "board", target: "qemu" } });
    expect((await test.app.inject({ method: "GET", url: "/api/runs/owned-run", headers: { authorization: `Bearer ${ownerToken}` } })).statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: "/api/runs/owned-run", headers: { authorization: `Bearer ${otherToken}` } })).statusCode).toBe(403);
    await test.app.close();
  });

  it("enforces limits, rolls back malformed/faulted batches, and retains duplicate-frame semantics", async () => {
    const test = fixture({ PRG32_BACKEND_METRICS_MAX_SAMPLES: "1", PRG32_BACKEND_METRICS_MAX_DB_WORK: "1", PRG32_BACKEND_METRICS_MAX_CONTENT_BYTES: "1024" });
    const admin = await adminSession(test.app);
    await test.app.inject({ method: "POST", url: "/api/runs", payload: { run_id: "bounded-run", board_id: "board", target: "qemu" } });
    const limited = await test.app.inject({ method: "POST", url: "/api/metrics/batch", payload: { run_id: "bounded-run", samples: [sample(1)] } });
    expect(limited.statusCode).toBe(200);
    const tooMany = await test.app.inject({ method: "POST", url: "/api/metrics/batch", payload: { run_id: "bounded-run", samples: [sample(3), sample(4)] } });
    expect(tooMany.statusCode).toBe(413); expect(tooMany.json()).toMatchObject({ code: "metrics_sample_limit" });
    const nested = await test.app.inject({ method: "POST", url: "/api/metrics/batch", payload: { run_id: "bounded-run", samples: [{ frame: { nested: 1 } }] } });
    expect(nested.statusCode).toBe(400); expect(nested.json()).toMatchObject({ code: "invalid_sample_structure" });
    const oversized = await test.app.inject({ method: "POST", url: "/api/metrics/batch", headers: { "content-type": "application/json" }, payload: JSON.stringify({ run_id: "bounded-run", samples: [{ frame: 5, blob: "x".repeat(20_000) }] }) });
    expect(oversized.statusCode).toBe(413); expect(oversized.json()).toMatchObject({ code: "metrics_payload_too_large" });
    const database = new Database(test.databasePath);
    const config = loadConfig({ PRG32_BACKEND_DB: path.join(test.root, "shadow-2.sqlite"), PRG32_BACKEND_STORE_DATA: test.storeRoot, PRG32_BACKEND_METRICS_MAX_SAMPLES: "4", PRG32_BACKEND_METRICS_MAX_DB_WORK: "4" });
    let failed = false;
    const service = new MetricsService({ config, database, writeEnabled: true, fault: (point) => { if (point === "after-batch-sample" && !failed) { failed = true; throw new Error("synthetic batch interruption"); } } });
    expect(() => service.createBatch({ run_id: "bounded-run", samples: [sample(99)] })).toThrow("metrics storage failed");
    expect((database.prepare("SELECT COUNT(*) AS count FROM samples WHERE run_id = 'bounded-run' AND frame = 99").get() as { count: number }).count).toBe(0);
    database.close();
    await test.app.close();
    void admin;
  });

  it("keeps metrics disabled unless the explicit domain gate is enabled and exposes the indexed query plan", async () => {
    const disabled = fixture({ PRG32_BACKEND_METRICS_WRITE_ENABLED: "false" });
    const response = await disabled.app.inject({ method: "POST", url: "/api/runs", payload: { run_id: "disabled", board_id: "board", target: "qemu" } });
    expect(response.statusCode).toBe(503); expect(response.json()).toMatchObject({ code: "metrics_unavailable" });
    await disabled.app.close();
    const test = fixture();
    const database = new Database(test.databasePath, { readonly: true });
    const plan = database.prepare("EXPLAIN QUERY PLAN SELECT frame FROM samples WHERE run_id = ? ORDER BY frame ASC").all("run") as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("samples_run_frame_idx"))).toBe(true);
    database.close();
  });
});
