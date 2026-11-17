import type Database from "better-sqlite3";

import type { Principal } from "../auth/principal.js";
import { AuthorizationService } from "../authorization/service.js";
import type { BackendConfig } from "../config/env.js";
import type { RuntimePolicy } from "../settings/runtime-policy.js";
import { MetricsError } from "./errors.js";
import {
  cleanText,
  formatOne,
  formatTwo,
  intValue,
  ownerCanView,
  recordBody,
  rowAsRun,
  rowAsSample,
  summarizeSamples,
} from "./codecs.js";
import type {
  DatabaseSource,
  MetricsServiceOptions,
  MetricsSummary,
  RunRecord,
  SampleRecord,
} from "./contracts.js";

export type {
  DatabaseSource,
  MetricsServiceOptions,
  MetricsSummary,
  RunRecord,
  SampleRecord,
} from "./contracts.js";
export { summarizeSamples } from "./codecs.js";

function fail(
  message: string,
  code: ConstructorParameters<typeof MetricsError>[1],
  statusCode = 400,
): never {
  throw new MetricsError(message, code, statusCode);
}

export class MetricsService {
  private readonly databaseSource: DatabaseSource;
  private readonly config: BackendConfig;
  private readonly writeEnabled: boolean;
  private readonly canonicalMode: boolean;
  private readonly fault: MetricsServiceOptions["fault"];
  private readonly authorization: AuthorizationService;
  private readonly policy: RuntimePolicy | undefined;

  constructor(options: MetricsServiceOptions) {
    this.databaseSource = options.database;
    this.config = options.config;
    this.writeEnabled = options.writeEnabled;
    this.canonicalMode = options.canonicalMode ?? false;
    this.fault = options.fault;
    this.authorization = options.authorization ?? new AuthorizationService();
    this.policy = options.policy;
  }

  private get database(): Database.Database { return typeof this.databaseSource === "function" ? this.databaseSource() : this.databaseSource; }

  private ensureWrite(): void {
    if (!this.writeEnabled) fail("metrics write isolation is unavailable", "metrics_unavailable", 503);
    if (this.policy && !this.policy.telemetryCollectionEnabled()) fail("telemetry collection is disabled", "metrics_unavailable", 503);
  }

  private runRow(runId: string): RunRecord | null {
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? rowAsRun(row) : null;
  }

  private samplesForRun(runId: string): SampleRecord[] {
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM samples WHERE run_id = ?").get(runId) as { count: number };
    if (count.count > this.config.metricsMaxExportSamples) fail("metrics export is too large", "metrics_export_too_large", 413);
    return (this.database.prepare(
      `SELECT frame, timestamp_ms, update_us, draw_us, present_us, frame_us,
              heap_free, heap_min_free, input_mask, fps_x100,
              upload_queue_depth, deadline_missed
       FROM samples WHERE run_id = ? ORDER BY frame ASC`
    ).all(runId) as Array<Record<string, unknown>>).map(rowAsSample);
  }

  createRun(value: unknown, principal: Principal): { ok: true; run_id: string } {
    this.ensureWrite();
    const payload = recordBody(value);
    const runId = cleanText(payload, "run_id", 96);
    const boardId = cleanText(payload, "board_id", 40);
    const target = cleanText(payload, "target", 24);
    if (!runId || !boardId || !target) fail("expected run_id, board_id, target", "invalid_metrics_payload");
    const record = {
      runId, boardId, target,
      displayBackend: cleanText(payload, "display_backend", 24),
      firmwareVersion: cleanText(payload, "firmware_version", 32),
      firmwareGitSha: cleanText(payload, "firmware_git_sha", 24),
      gameName: cleanText(payload, "game_name", 40),
      samplePeriodFrames: intValue(payload.sample_period_frames, 1, 1),
      startedAt: intValue(payload.started_ms, Math.trunc(Date.now()), 0),
      submittedBy: principal.name,
      userId: principal.authenticated ? principal.id : null
    };
    const db = this.database;
    try {
      db.exec("BEGIN IMMEDIATE");
      if (this.canonicalMode) {
        const existing = db.prepare("SELECT board_id, target, display_backend, firmware_version, firmware_git_sha, game_name, sample_period_frames, started_at, submitted_by, user_id FROM runs WHERE run_id = ?").get(record.runId) as Record<string, unknown> | undefined;
        if (existing) {
          const same = existing.board_id === record.boardId
            && existing.target === record.target
            && existing.display_backend === record.displayBackend
            && existing.firmware_version === record.firmwareVersion
            && existing.firmware_git_sha === record.firmwareGitSha
            && existing.game_name === record.gameName
            && existing.sample_period_frames === record.samplePeriodFrames
            && existing.started_at === record.startedAt
            && existing.submitted_by === record.submittedBy
            && (existing.user_id ?? null) === (record.userId ?? null);
          if (!same) throw new MetricsError("run already exists with different metadata", "run_state_conflict", 409);
          db.exec("COMMIT");
          return { ok: true, run_id: runId };
        }
      }
      db.prepare(
        `INSERT INTO runs(run_id, board_id, target, display_backend, firmware_version,
          firmware_git_sha, game_name, sample_period_frames, started_at, submitted_by, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
          board_id = excluded.board_id, target = excluded.target,
          display_backend = excluded.display_backend, firmware_version = excluded.firmware_version,
          firmware_git_sha = excluded.firmware_git_sha, game_name = excluded.game_name,
          sample_period_frames = excluded.sample_period_frames, started_at = excluded.started_at,
          submitted_by = excluded.submitted_by`
      ).run(record.runId, record.boardId, record.target, record.displayBackend, record.firmwareVersion, record.firmwareGitSha, record.gameName, record.samplePeriodFrames, record.startedAt, record.submittedBy, record.userId);
      db.exec("COMMIT");
      return { ok: true, run_id: runId };
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      if (error instanceof MetricsError) throw error;
      throw new MetricsError("metrics storage failed", "metrics_storage_failed", 500, { cause: error });
    }
  }

  createBatch(value: unknown): { ok: true; inserted: number; received: number } {
    this.ensureWrite();
    const payload = recordBody(value);
    const runId = cleanText(payload, "run_id", 96);
    const samples = payload.samples;
    if (!runId || !Array.isArray(samples)) fail("expected run_id and samples", "invalid_metrics_payload");
    if (samples.length > this.config.metricsMaxSamplesPerRequest) fail("too many samples in one request", "metrics_sample_limit", 413);
    const dropped = intValue(payload.dropped_samples, 0, 0);
    if (samples.length + (dropped ? 1 : 0) > this.config.metricsMaxDbWork) fail("metrics request requires too much database work", "metrics_work_limit", 413);
    if (samples.some((sample) => sample === null || typeof sample !== "object" || Array.isArray(sample) || Object.values(sample as Record<string, unknown>).some((item) => item !== null && typeof item === "object"))) {
      fail("samples must be objects with scalar values", "invalid_sample_structure");
    }
    if (!this.runRow(runId)) fail("run_id not found", "run_not_found", 404);
    const normalized = (samples as Array<Record<string, unknown>>).map((sample) => ({
      frame: intValue(sample.frame, 0, 0), timestampMs: intValue(sample.timestamp_ms, 0, 0), updateUs: intValue(sample.update_us, 0, 0), drawUs: intValue(sample.draw_us, 0, 0), presentUs: intValue(sample.present_us, 0, 0), frameUs: intValue(sample.frame_us, 0, 0), heapFree: intValue(sample.heap_free, 0, 0), heapMinFree: intValue(sample.heap_min_free, 0, 0), inputMask: intValue(sample.input_mask, 0, 0), fpsX100: intValue(sample.fps_x100, 0, 0), uploadQueueDepth: intValue(sample.upload_queue_depth, 0, 0), deadlineMissed: sample.deadline_missed ? 1 : 0
    }));
    const db = this.database;
    let inserted = 0;
    try {
      db.exec("BEGIN IMMEDIATE");
      const insert = db.prepare(
        `INSERT OR IGNORE INTO samples(run_id, frame, timestamp_ms, update_us, draw_us, present_us,
          frame_us, heap_free, heap_min_free, input_mask, fps_x100, upload_queue_depth, deadline_missed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const sample of normalized) {
        const result = insert.run(runId, sample.frame, sample.timestampMs, sample.updateUs, sample.drawUs, sample.presentUs, sample.frameUs, sample.heapFree, sample.heapMinFree, sample.inputMask, sample.fpsX100, sample.uploadQueueDepth, sample.deadlineMissed);
        inserted += result.changes;
        this.fault?.("after-batch-sample");
      }
      if (dropped) db.prepare("UPDATE runs SET dropped_samples = dropped_samples + ? WHERE run_id = ?").run(dropped, runId);
      this.fault?.("before-batch-commit");
      db.exec("COMMIT");
      return { ok: true, inserted, received: samples.length };
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      if (error instanceof MetricsError) throw error;
      throw new MetricsError("metrics storage failed", "metrics_storage_failed", 500, { cause: error });
    }
  }

  finishRun(runId: string, value: unknown): { ok: true; run_id: string } {
    this.ensureWrite();
    const payload = value === undefined || value === null ? {} : recordBody(value);
    const finishedAt = intValue(payload.finished_ms, Math.trunc(Date.now()), 0);
    const dropped = intValue(payload.dropped_samples, 0, 0);
    const db = this.database;
    if (this.canonicalMode) {
      try {
        db.exec("BEGIN IMMEDIATE");
        const existing = db.prepare("SELECT finished_at FROM runs WHERE run_id = ?").get(runId) as { finished_at: number | null } | undefined;
        if (!existing) fail("run_id not found", "run_not_found", 404);
        if (existing.finished_at !== null && existing.finished_at !== finishedAt) {
          throw new MetricsError("run has already been completed with a different timestamp", "run_state_conflict", 409);
        }
        db.prepare("UPDATE runs SET finished_at = ?, dropped_samples = MAX(dropped_samples, ?) WHERE run_id = ?").run(finishedAt, dropped, runId);
        db.exec("COMMIT");
        return { ok: true, run_id: runId };
      } catch (error) {
        if (db.inTransaction) db.exec("ROLLBACK");
        if (error instanceof MetricsError) throw error;
        throw new MetricsError("metrics storage failed", "metrics_storage_failed", 500, { cause: error });
      }
    }
    const changes = db.prepare("UPDATE runs SET finished_at = ?, dropped_samples = MAX(dropped_samples, ?) WHERE run_id = ?").run(finishedAt, dropped, runId).changes;
    if (changes === 0) fail("run_id not found", "run_not_found", 404);
    return { ok: true, run_id: runId };
  }

  listRuns(principal: Principal): RunRecord[] {
    if (!principal.authenticated) return [];
    const params: unknown[] = [];
    const canReadAny = this.authorization.hasPermission(principal, "runs:read:any");
    if (!this.authorization.hasPermission(principal, "runs:read:self") && !canReadAny) return [];
    const where = canReadAny ? "" : "WHERE runs.user_id = ?";
    if (where) params.push(principal.id);
    return (this.database.prepare(
      `SELECT runs.*, COUNT(samples.id) AS sample_count FROM runs
       LEFT JOIN samples ON samples.run_id = runs.run_id ${where}
       GROUP BY runs.run_id ORDER BY runs.created_at DESC`
    ).all(...params) as Array<Record<string, unknown>>).map(rowAsRun);
  }

  detail(runId: string, principal: Principal): { ok: true; run: RunRecord; summary: MetricsSummary } {
    const run = this.runRow(runId);
    if (!run) fail("run_id not found", "run_not_found", 404);
    if (!ownerCanView(run, principal, this.authorization)) fail("forbidden", "metrics_forbidden", 403);
    const samples = this.samplesForRun(runId);
    return { ok: true, run, summary: summarizeSamples(samples) };
  }

  jsonExport(runId: string, principal: Principal): { ok: true; run: RunRecord; samples: SampleRecord[]; summary: MetricsSummary } {
    const run = this.runRow(runId);
    if (!run) fail("run_id not found", "run_not_found", 404);
    if (!ownerCanView(run, principal, this.authorization)) fail("forbidden", "metrics_forbidden", 403);
    const samples = this.samplesForRun(runId);
    return { ok: true, run, samples, summary: summarizeSamples(samples) };
  }

  csvExport(runId: string, principal: Principal): string {
    const run = this.runRow(runId);
    if (!run) fail("run_id not found", "run_not_found", 404);
    if (!ownerCanView(run, principal, this.authorization)) fail("forbidden", "metrics_forbidden", 403);
    const fields: Array<keyof SampleRecord> = ["frame", "timestamp_ms", "update_us", "draw_us", "present_us", "frame_us", "heap_free", "heap_min_free", "input_mask", "fps_x100", "upload_queue_depth", "deadline_missed"];
    const samples = this.samplesForRun(runId);
    return `${fields.join(",")}\n${samples.map((sample) => fields.map((field) => String(sample[field])).join(",")).join("\n")}${samples.length ? "\n" : ""}`;
  }

  markdownExport(runId: string, principal: Principal): string {
    const run = this.runRow(runId);
    if (!run) fail("run_id not found", "run_not_found", 404);
    if (!ownerCanView(run, principal, this.authorization)) fail("forbidden", "metrics_forbidden", 403);
    const samples = this.samplesForRun(runId);
    const summary = summarizeSamples(samples);
    const deadlinePercent = summary.sample_count ? (100 * summary.deadline_missed) / summary.sample_count : 0;
    const submittedBy = run.submitted_by || "anonymous";
    return [
      "# PRG32 Metrics Report", "",
      `- Run: \`${run.run_id}\``, `- Board: \`${run.board_id}\``, `- Target: \`${run.target}\``, `- Display: \`${run.display_backend}\``,
      `- Firmware: \`${run.firmware_version}\` (\`${run.firmware_git_sha}\`)`, `- Game: \`${run.game_name}\``, `- Submitted by: \`${submittedBy}\``,
      `- Sample period: ${run.sample_period_frames} frame(s)`, `- Dropped samples: ${run.dropped_samples}`, "",
      "| Metric | Value |", "|---|---:|", `| Samples | ${summary.sample_count} |`, `| Average frame work | ${formatOne(summary.frame_us_avg)} us |`,
      `| Median frame work | ${formatOne(summary.frame_us_median)} us |`, `| p95 frame work | ${formatOne(summary.frame_us_p95)} us |`, `| Max frame work | ${summary.frame_us_max} us |`,
      `| Average update | ${formatOne(summary.update_us_avg)} us |`, `| Average draw | ${formatOne(summary.draw_us_avg)} us |`, `| Average present | ${formatOne(summary.present_us_avg)} us |`,
      `| Average active FPS | ${formatTwo(summary.fps_avg)} |`, `| Deadline misses | ${summary.deadline_missed} (${formatOne(deadlinePercent)}%) |`, ""
    ].join("\n");
  }
}
