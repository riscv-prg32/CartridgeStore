import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { CANONICAL_READ_AUTHORIZATION, CANONICAL_WRITE_AUTHORIZATION } from "../src/storage-v2/read-mode.js";
import { createDisposableCanonicalReadFixture, disposeDifferentialFixtures } from "../src/storage-v2/differential/harness.js";
import { inventoryLegacySnapshot } from "../src/storage-v2/legacy/inventory.js";
import { verifyMigratedTarget } from "../src/storage-v2/migration/verification.js";

const BOOTSTRAP = "m52g3-disposable-bootstrap-token-1234567890";
const SESSION_SECRET = "m52g3-disposable-session-secret-1234567890";

function environment(fixture: ReturnType<typeof createDisposableCanonicalReadFixture>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PRG32_BACKEND_DB: path.join(fixture.sourceRoot, "store.sqlite"),
    PRG32_BACKEND_STORE_DATA: fixture.sourceRoot,
    PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: fixture.targetRoot,
    PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: CANONICAL_READ_AUTHORIZATION,
    PRG32_BACKEND_CANONICAL_WORKFLOW_MODE: "disposable",
    PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION: CANONICAL_WRITE_AUTHORIZATION,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: path.join(fixture.targetRoot, "store.sqlite"),
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: fixture.targetRoot,
    PRG32_BACKEND_SESSION_SECRET: SESSION_SECRET,
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false",
    ...extra
  };
}

function header(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function adminSession(app: ReturnType<typeof buildApp>): Promise<{ cookie: string; csrf: string }> {
  const bootstrap = await app.inject({
    method: "POST",
    url: "/auth/bootstrap",
    headers: { "x-prg32-bootstrap-token": BOOTSTRAP },
    payload: { username: "canonical-telemetry-admin", email: "canonical-telemetry-admin@example.test", password: "long-password-123", password_confirm: "long-password-123" }
  });
  expect(bootstrap.statusCode).toBe(201);
  const cookie = header(bootstrap, "set-cookie").split(";", 1)[0] ?? "";
  const csrfResponse = await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie } });
  expect(csrfResponse.statusCode).toBe(200);
  return { cookie, csrf: csrfResponse.json<{ csrf_token: string }>().csrf_token };
}

function sample(frame: number): Record<string, unknown> {
  return { frame, timestamp_ms: 1000 + frame, update_us: 10, draw_us: 20, present_us: 30, frame_us: 60, heap_free: 100, heap_min_free: 90, input_mask: 0, fps_x100: 6000, upload_queue_depth: 0, deadline_missed: false };
}

afterEach(() => disposeDifferentialFixtures());

describe("canonical telemetry, scores, runs and metrics", () => {
  it("writes downloads, scores, runs and samples to the same canonical database and preserves historical data", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const manifest = inventoryLegacySnapshot(fixture.sourceConfig).manifest;
    const before = new Database(path.join(fixture.targetRoot, "store.sqlite"), { readonly: true, fileMustExist: true });
    const migrationId = String((before.prepare("SELECT operation_id FROM publication_operations WHERE operation_kind = 'migration' ORDER BY created_at LIMIT 1").get() as { operation_id: string }).operation_id);
    const reconciliation = verifyMigratedTarget(fixture.sourceConfig, manifest, fixture.targetRoot, migrationId);
    expect(reconciliation.ok).toBe(true);
    const historical = {
      downloads: Number((before.prepare("SELECT COUNT(*) AS count FROM download_events").get() as { count: number }).count),
      scores: Number((before.prepare("SELECT COUNT(*) AS count FROM scores").get() as { count: number }).count),
      runs: Number((before.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count),
      samples: Number((before.prepare("SELECT COUNT(*) AS count FROM samples").get() as { count: number }).count),
      exceptions: Number((before.prepare("SELECT COUNT(*) AS count FROM migration_exceptions").get() as { count: number }).count)
    };
    expect(before.prepare("SELECT score FROM scores WHERE game = 'org.example.alpha'").get()).toEqual({ score: 9001 });
    expect(before.prepare("SELECT run_id FROM runs WHERE run_id = 'run-m52d'").get()).toEqual({ run_id: "run-m52d" });
    const targetBefore = fs.readFileSync(path.join(fixture.targetRoot, "store.sqlite"));
    before.close();
  const sourceBefore = fs.readFileSync(path.join(fixture.sourceRoot, "store.sqlite"));
    const indexBefore = fs.readFileSync(path.join(fixture.sourceRoot, "index.json"));

    const app = buildApp({ config: loadConfig(environment(fixture)), logger: false });
    const admin = await adminSession(app);
    const download = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu", headers: { "user-agent": "m52g3-test-agent" } });
    expect(download.statusCode).toBe(200);
    const etag = String(download.headers.etag);
    const partial = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu", headers: { range: "bytes=0-7" } });
    expect(partial.statusCode).toBe(206);
    expect(partial.rawPayload.byteLength).toBe(8);
    const conditional = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu", headers: { "if-none-match": etag } });
    expect(conditional.statusCode).toBe(304);
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu" })));
    expect(concurrent.every((response) => response.statusCode === 200)).toBe(true);
    const invalidRange = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu", headers: { range: "bytes=bad" } });
    expect(invalidRange.statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?version=9.9.9&architecture=qemu" });
    expect(missing.statusCode).toBe(400);

    const score = await app.inject({ method: "POST", url: "/api/scores", payload: { game: "org.example.alpha", player: "firmware", score: 1234 } });
    expect(score.statusCode).toBe(200);
    const run = await app.inject({ method: "POST", url: "/api/runs", payload: { run_id: "canonical-run", board_id: "board", target: "qemu", game_name: "org.example.alpha", started_ms: 1000 } });
    expect(run.statusCode).toBe(200);
    const retryRun = await app.inject({ method: "POST", url: "/api/runs", payload: { run_id: "canonical-run", board_id: "board", target: "qemu", game_name: "org.example.alpha", started_ms: 1000 } });
    expect(retryRun.statusCode).toBe(200);
    const conflictingRun = await app.inject({ method: "POST", url: "/api/runs", payload: { run_id: "canonical-run", board_id: "other-board", target: "qemu", game_name: "org.example.alpha", started_ms: 1000 } });
    expect(conflictingRun.statusCode).toBe(409);
    const batch = await app.inject({ method: "POST", url: "/api/metrics/batch", payload: { run_id: "canonical-run", samples: [sample(1), sample(2)], dropped_samples: 1 } });
    expect(batch.statusCode).toBe(200);
    const finish = await app.inject({ method: "POST", url: "/api/runs/canonical-run/finish", payload: { finished_ms: 2000, dropped_samples: 2 } });
    expect(finish.statusCode).toBe(200);
    const duplicateFinish = await app.inject({ method: "POST", url: "/api/runs/canonical-run/finish", payload: { finished_ms: 2000, dropped_samples: 2 } });
    expect(duplicateFinish.statusCode).toBe(200);
    const conflictingFinish = await app.inject({ method: "POST", url: "/api/runs/canonical-run/finish", payload: { finished_ms: 3000, dropped_samples: 2 } });
    expect(conflictingFinish.statusCode).toBe(409);
    const detail = await app.inject({ method: "GET", url: "/api/runs/canonical-run", headers: { cookie: admin.cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ summary: { sample_count: number } }>().summary.sample_count).toBe(2);

    const statsDownloads = await app.inject({ method: "GET", url: "/api/stats/downloads" });
    expect(statsDownloads.statusCode).toBe(200);
    expect(statsDownloads.json<{ total: number }>().total).toBe(historical.downloads + 13);
    const statsScores = await app.inject({ method: "GET", url: "/api/stats/scores" });
    expect(statsScores.json<{ scores: Array<{ score: number }> }>().scores.some((item) => item.score === 1234)).toBe(true);
    const statsRuns = await app.inject({ method: "GET", url: "/api/stats/runs" });
    expect(statsRuns.json()).toMatchObject({ total: historical.runs + 1, finished: 1 });
    void admin;

    await app.close();
    const after = new Database(path.join(fixture.targetRoot, "store.sqlite"), { readonly: true, fileMustExist: true });
    expect((after.prepare("SELECT COUNT(*) AS count FROM download_events").get() as { count: number }).count).toBe(historical.downloads + 13);
    expect((after.prepare("SELECT COUNT(*) AS count FROM scores").get() as { count: number }).count).toBe(historical.scores + 1);
    expect((after.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count).toBe(historical.runs + 1);
    expect((after.prepare("SELECT COUNT(*) AS count FROM samples WHERE run_id = 'canonical-run'").get() as { count: number }).count).toBe(2);
    expect((after.prepare("SELECT COUNT(*) AS count FROM migration_exceptions").get() as { count: number }).count).toBe(historical.exceptions);
    expect(after.prepare("SELECT user_id, delivery_outcome FROM download_events ORDER BY id DESC LIMIT 1").get()).toEqual({ user_id: null, delivery_outcome: "started" });
    after.close();
    expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(fixture.targetRoot, "store.sqlite"))).digest("hex")).not.toBe(crypto.createHash("sha256").update(targetBefore).digest("hex"));
  expect(fs.readFileSync(path.join(fixture.sourceRoot, "store.sqlite"))).toEqual(sourceBefore);
    expect(fs.readFileSync(path.join(fixture.sourceRoot, "index.json"))).toEqual(indexBefore);
    expect(fs.existsSync(path.join(fixture.targetRoot, "index.json"))).toBe(false);
  }, 60_000);

  it("enforces canonical score rate limits without changing legacy mode", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const app = buildApp({ config: loadConfig(environment(fixture, {
      PRG32_BACKEND_SCORES_RATE_LIMIT_MAX: "1",
      PRG32_BACKEND_SCORES_RATE_LIMIT_BURST: "1"
    })), logger: false });
    expect((await app.inject({ method: "POST", url: "/api/scores", payload: { game: "rate", player: "one", score: 1 } })).statusCode).toBe(200);
    const limited = await app.inject({ method: "POST", url: "/api/scores", payload: { game: "rate", player: "two", score: 2 } });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it("fails closed when private staging contains an orphaned submission directory", () => {
    const fixture = createDisposableCanonicalReadFixture();
    const orphan = path.join(fixture.targetRoot, "storage", "staging", "submissions", "999999");
    fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });
    expect(() => buildApp({ config: loadConfig(environment(fixture)), logger: false })).toThrow(/recovery/iu);
  });
});
