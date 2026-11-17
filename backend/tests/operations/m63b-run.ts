import os from "node:os";

import Database from "better-sqlite3";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { MetricsService } from "../../src/metrics/service.js";
import type { Principal } from "../../src/auth/principal.js";
import {
  createFixture,
  fileSizes,
  runBackupExperiment,
  runConcurrencyExperiment,
  runRateLimiterExperiment,
  runWalExperiment,
  timeAsyncOperation,
  timeOperation,
  WORKLOADS,
  type Fixture,
  type TimingSummary,
  type WorkloadSize
} from "./m63b-harness.js";

interface PlanRow { readonly detail: string; }

interface QueryMeasurement {
  readonly path: string;
  readonly layer: "sqlite" | "http" | "service";
  readonly timing: TimingSummary;
  readonly cardinality: number | null;
}

interface WorkloadResult {
  readonly workload: WorkloadSize;
  readonly rows: Record<string, number>;
  readonly fileSizes: ReturnType<typeof fileSizes>;
  readonly measurements: readonly QueryMeasurement[];
  readonly plans: Record<string, readonly string[]>;
}

const admin: Principal = {
  authenticated: true,
  id: 1,
  name: "synthetic-admin",
  username: "synthetic-admin",
  email: "synthetic@example.invalid",
  role: "admin",
  groups: [],
  authMethod: "legacy"
};

function count(database: Database.Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

function plan(database: Database.Database, sql: string, parameters: readonly unknown[] = []): string[] {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as PlanRow[]).map((row) => row.detail);
}

function runSqliteMeasurements(database: Database.Database, fixture: Fixture): QueryMeasurement[] {
  const measurements: QueryMeasurement[] = [];
  const add = (name: string, operation: () => unknown, cardinality: number | null): void => {
    measurements.push({ path: name, layer: "sqlite", timing: timeOperation(operation), cardinality });
  };
  add("GET /api/scores", () => database.prepare("SELECT game, player, score, created_at, submitted_by FROM scores ORDER BY score DESC, created_at ASC LIMIT ?").all(20), Math.min(20, fixture.size.scores));
  add("GET /api/scores?game=game-01", () => database.prepare("SELECT game, player, score, created_at, submitted_by FROM scores WHERE game = ? ORDER BY score DESC, created_at ASC LIMIT ?").all("game-01", 20), Math.min(20, Math.ceil(fixture.size.scores / 50)));
  add("GET /api/stats/downloads", () => database.prepare("SELECT date(downloaded_at) AS bucket, COUNT(*) AS downloads FROM download_events GROUP BY bucket ORDER BY bucket DESC LIMIT ?").all(30), Math.min(30, 60));
  add("GET /api/stats/downloads/:game_id", () => database.prepare("SELECT architecture, COUNT(*) AS downloads FROM download_events WHERE game_id = ? GROUP BY architecture ORDER BY downloads DESC, architecture ASC").all("game-01"), 2);
  add("GET /api/stats/scores", () => database.prepare("SELECT game, player, score, created_at, submitted_by FROM scores ORDER BY score DESC, created_at ASC LIMIT ?").all(20), Math.min(20, fixture.size.scores));
  add("GET /api/stats/runs", () => database.prepare("SELECT COUNT(*) AS count FROM runs").get(), 1);
  add("GET /api/runs", () => database.prepare("SELECT runs.*, COUNT(samples.id) AS sample_count FROM runs LEFT JOIN samples ON samples.run_id = runs.run_id GROUP BY runs.run_id ORDER BY runs.created_at DESC").all(), fixture.size.runs);
  add("GET /api/runs/:run_id detail samples", () => database.prepare("SELECT frame, timestamp_ms, update_us, draw_us, present_us, frame_us, heap_free, heap_min_free, input_mask, fps_x100, upload_queue_depth, deadline_missed FROM samples WHERE run_id = ? ORDER BY frame ASC").all("run-000000"), Math.ceil(fixture.size.samples / fixture.size.runs));
  return measurements;
}

async function runHttpMeasurements(fixture: Fixture): Promise<QueryMeasurement[]> {
  const app = buildApp({
    config: loadConfig({ PRG32_BACKEND_DB: fixture.databasePath, PRG32_BACKEND_STORE_DATA: fixture.storeRoot, PRG32_BACKEND_SESSION_SECURE: "false" }),
    logger: false,
    nowSeconds: () => 1_700_000_000
  });
  const measurements: QueryMeasurement[] = [];
  const add = async (name: string, url: string, cardinality: number | null): Promise<void> => {
    const timing = await timeAsyncOperation(() => app.inject({ method: "GET", url }), 10);
    measurements.push({ path: name, layer: "http", timing, cardinality });
  };
  await add("GET /api/scores", "/api/scores", Math.min(20, fixture.size.scores));
  await add("GET /api/stats/downloads", "/api/stats/downloads", Math.min(30, 60));
  await add("GET /api/stats/downloads/:game_id", "/api/stats/downloads/game-01", 1);
  await add("GET /api/stats/scores", "/api/stats/scores", Math.min(20, fixture.size.scores));
  await add("GET /api/stats/runs", "/api/stats/runs", 1);
  await add("GET /api/runs", "/api/runs", 0);
  await app.close();
  return measurements;
}

function runServiceMeasurements(fixture: Fixture): QueryMeasurement[] {
  const database = new Database(fixture.databasePath, { readonly: true });
  const config = loadConfig({ PRG32_BACKEND_DB: fixture.databasePath, PRG32_BACKEND_STORE_DATA: fixture.storeRoot });
  const metrics = new MetricsService({ config, database, writeEnabled: false });
  const measurements: QueryMeasurement[] = [];
  const sampleCount = Math.ceil(fixture.size.samples / fixture.size.runs);
  measurements.push({ path: "GET /api/runs (admin)", layer: "service", timing: timeOperation(() => metrics.listRuns(admin)), cardinality: fixture.size.runs });
  measurements.push({ path: "GET /api/runs/:run_id detail (admin)", layer: "service", timing: timeOperation(() => metrics.detail("run-000000", admin)), cardinality: sampleCount });
  measurements.push({ path: "GET /api/runs/:run_id samples.csv (admin)", layer: "service", timing: timeOperation(() => metrics.csvExport("run-000000", admin)), cardinality: sampleCount });
  measurements.push({ path: "GET /api/runs/:run_id report.md (admin)", layer: "service", timing: timeOperation(() => metrics.markdownExport("run-000000", admin)), cardinality: sampleCount });
  database.close();
  return measurements;
}

function runPlans(database: Database.Database): Record<string, readonly string[]> {
  return {
    scores_global: plan(database, "SELECT game, player, score, created_at, submitted_by FROM scores ORDER BY score DESC, created_at ASC LIMIT ?", [20]),
    scores_game: plan(database, "SELECT game, player, score, created_at, submitted_by FROM scores WHERE game = ? ORDER BY score DESC, created_at ASC LIMIT ?", ["game-01", 20]),
    downloads_series: plan(database, "SELECT date(downloaded_at) AS bucket, COUNT(*) AS downloads FROM download_events GROUP BY bucket ORDER BY bucket DESC LIMIT ?", [30]),
    downloads_game_architecture: plan(database, "SELECT architecture, COUNT(*) AS downloads FROM download_events WHERE game_id = ? GROUP BY architecture ORDER BY downloads DESC, architecture ASC", ["game-01"]),
    runs_summary: plan(database, "SELECT COUNT(*) AS count FROM runs WHERE created_at >= ?", [1_699_395_200]),
    runs_list: plan(database, "SELECT runs.*, COUNT(samples.id) AS sample_count FROM runs LEFT JOIN samples ON samples.run_id = runs.run_id GROUP BY runs.run_id ORDER BY runs.created_at DESC"),
    samples_by_run: plan(database, "SELECT frame, timestamp_ms, frame_us FROM samples WHERE run_id = ? ORDER BY frame ASC", ["run-000000"])
  };
}

async function runWorkload(size: WorkloadSize): Promise<WorkloadResult> {
  const fixture = createFixture(size);
  try {
    const database = new Database(fixture.databasePath, { readonly: true });
    const rows = Object.fromEntries(["scores", "runs", "samples", "download_events"].map((table) => [table, count(database, table)]));
    const plans = runPlans(database);
    const sqliteMeasurements = runSqliteMeasurements(database, fixture);
    database.close();
    const httpMeasurements = await runHttpMeasurements(fixture);
    const serviceMeasurements = runServiceMeasurements(fixture);
    return { workload: size, rows, fileSizes: fileSizes(fixture.databasePath), measurements: [...sqliteMeasurements, ...httpMeasurements, ...serviceMeasurements], plans };
  } finally {
    fixture.close();
  }
}

function selectedWorkloads(): WorkloadSize[] {
  const value = process.argv.find((argument) => argument.startsWith("--workloads="))?.split("=", 2)[1] ?? "small,medium";
  return value.split(",").map((name) => {
    if (!(name in WORKLOADS)) throw new Error(`unknown workload: ${name}`);
    return WORKLOADS[name as WorkloadSize["name"]];
  });
}

async function main(): Promise<void> {
  const workloads: WorkloadResult[] = [];
  for (const size of selectedWorkloads()) workloads.push(await runWorkload(size));
  const experimentFixture = createFixture(WORKLOADS.small, "prg32-m63b-experiment-");
  const wal = runWalExperiment(experimentFixture.root);
  const concurrency = await runConcurrencyExperiment(experimentFixture.root);
  const backup = await runBackupExperiment(experimentFixture);
  const rateLimiter = runRateLimiterExperiment();
  experimentFixture.close();
  console.log(JSON.stringify({
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpu_count: os.cpus().length,
    workloads,
    experiments: { wal, concurrency, backup, rateLimiter }
  }, null, 2));
}

await main();
