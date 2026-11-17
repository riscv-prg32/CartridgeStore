import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import Database from "better-sqlite3";

import { ScoreRateLimiter } from "../../src/scores/service.js";

export interface WorkloadSize {
  readonly name: "small" | "medium" | "large";
  readonly scores: number;
  readonly runs: number;
  readonly samples: number;
  readonly downloads: number;
}

export const WORKLOADS: Record<WorkloadSize["name"], WorkloadSize> = {
  small: { name: "small", scores: 1_000, runs: 100, samples: 10_000, downloads: 1_000 },
  medium: { name: "medium", scores: 10_000, runs: 1_000, samples: 100_000, downloads: 10_000 },
  large: { name: "large", scores: 100_000, runs: 10_000, samples: 1_000_000, downloads: 100_000 }
};

export const SQLITE_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
  CREATE TABLE runs (run_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, target TEXT NOT NULL, display_backend TEXT NOT NULL DEFAULT '', firmware_version TEXT NOT NULL DEFAULT '', firmware_git_sha TEXT NOT NULL DEFAULT '', game_name TEXT NOT NULL DEFAULT '', sample_period_frames INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL, finished_at INTEGER, dropped_samples INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL DEFAULT '', user_id INTEGER);
  CREATE TABLE samples (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, frame INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, update_us INTEGER NOT NULL, draw_us INTEGER NOT NULL, present_us INTEGER NOT NULL, frame_us INTEGER NOT NULL, heap_free INTEGER NOT NULL, heap_min_free INTEGER NOT NULL, input_mask INTEGER NOT NULL, fps_x100 INTEGER NOT NULL, upload_queue_depth INTEGER NOT NULL, deadline_missed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(run_id, frame));
  CREATE TABLE scores (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, player TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL, submitted_by TEXT NOT NULL DEFAULT '');
  CREATE TABLE download_events (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, version TEXT NOT NULL, architecture TEXT NOT NULL, user_id INTEGER, ip_hash TEXT, user_agent TEXT, downloaded_at TEXT NOT NULL);
  CREATE INDEX samples_run_frame_idx ON samples(run_id, frame);
  CREATE INDEX samples_run_frame_time_idx ON samples(run_id, frame_us);
  CREATE INDEX scores_game_score_idx ON scores(game, score DESC, created_at ASC);
  CREATE INDEX download_events_game_idx ON download_events(game_id, downloaded_at);
  CREATE INDEX download_events_arch_idx ON download_events(architecture);
`;

export interface Fixture {
  readonly root: string;
  readonly databasePath: string;
  readonly storeRoot: string;
  readonly size: WorkloadSize;
  readonly close: () => void;
}

export interface FileSizes {
  readonly main: number;
  readonly wal: number;
  readonly shm: number;
  readonly total: number;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

export function fileSizes(databasePath: string): FileSizes {
  const main = fileSize(databasePath);
  const wal = fileSize(`${databasePath}-wal`);
  const shm = fileSize(`${databasePath}-shm`);
  return { main, wal, shm, total: main + wal + shm };
}

function game(index: number): string {
  return `game-${String(index % 50).padStart(2, "0")}`;
}

function insertWorkload(database: Database.Database, size: WorkloadSize): void {
  const insertScore = database.prepare("INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES (?, ?, ?, ?, ?)");
  const insertRun = database.prepare("INSERT INTO runs(run_id, board_id, target, game_name, started_at, finished_at, created_at, submitted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertSample = database.prepare("INSERT INTO samples(run_id, frame, timestamp_ms, update_us, draw_us, present_us, frame_us, heap_free, heap_min_free, input_mask, fps_x100, upload_queue_depth, deadline_missed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertDownload = database.prepare("INSERT INTO download_events(game_id, version, architecture, downloaded_at) VALUES (?, ?, ?, ?)");
  const samplesPerRun = Math.max(1, Math.ceil(size.samples / size.runs));
  database.transaction(() => {
    for (let index = 0; index < size.scores; index += 1) {
      insertScore.run(game(index), `player-${index % 200}`, (index * 7919) % 1_000_000, 1_700_000_000 + index, "synthetic");
    }
    for (let index = 0; index < size.runs; index += 1) {
      const runId = `run-${String(index).padStart(6, "0")}`;
      const createdAt = 1_700_000_000 + index;
      insertRun.run(runId, `board-${index % 10}`, index % 2 === 0 ? "qemu" : "esp32c6", game(index), createdAt * 1000, index % 3 === 0 ? createdAt * 1000 + 1_000 : null, createdAt, "synthetic");
      const count = Math.min(samplesPerRun, size.samples - index * samplesPerRun);
      for (let frame = 0; frame < count; frame += 1) {
        const frameUs = 8_000 + ((index + frame) % 2_000);
        insertSample.run(runId, frame, frame * 16, 1_000, 2_000, 3_000, frameUs, 200_000, 180_000, frame % 4, 6_000, frame % 5, frame % 97 === 0 ? 1 : 0, createdAt);
      }
    }
    for (let index = 0; index < size.downloads; index += 1) {
      const day = index % 60;
      const hour = index % 24;
      insertDownload.run(game(index), `1.0.${index % 3}`, index % 2 === 0 ? "qemu" : "esp32c6", `2026-01-${String(day + 1).padStart(2, "0")} ${String(hour).padStart(2, "0")}:00:00`);
    }
  })();
}

export function createFixture(size: WorkloadSize, prefix = "prg32-m63b-"): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(root, "capacity.sqlite");
  const storeRoot = path.join(root, "store");
  fs.mkdirSync(storeRoot);
  fs.writeFileSync(path.join(storeRoot, "index.json"), JSON.stringify({
    abi: "prg32-cartridge-store-index-1.0",
    games: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [game(index), {
      id: game(index), title: `Synthetic ${game(index)}`, latest_version: "1.0.0", updated_at: "2026-01-01T00:00:00Z",
      versions: { "1.0.0": { architectures: { qemu: { filename: "unused.prg32" } } } }
    }]))
  }));
  const database = new Database(databasePath);
  database.exec(SQLITE_SCHEMA);
  insertWorkload(database, size);
  return {
    root,
    databasePath,
    storeRoot,
    size,
    close: () => {
      if (database.open) database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

export interface TimingSummary {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly samples: number;
}

export function summarizeTimings(values: readonly number[]): TimingSummary {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (q: number): number => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * q))] ?? 0;
  return {
    medianMs: ordered[Math.floor(ordered.length / 2)] ?? 0,
    p95Ms: percentile(0.95),
    maxMs: ordered[ordered.length - 1] ?? 0,
    samples: ordered.length
  };
}

export function timeOperation(operation: () => unknown, repetitions = 15): TimingSummary {
  for (let index = 0; index < 3; index += 1) operation();
  const timings: number[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    const start = process.hrtime.bigint();
    operation();
    timings.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }
  return summarizeTimings(timings);
}

export async function timeAsyncOperation(operation: () => Promise<unknown>, repetitions = 10): Promise<TimingSummary> {
  for (let index = 0; index < 2; index += 1) await operation();
  const timings: number[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    const start = process.hrtime.bigint();
    await operation();
    timings.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }
  return summarizeTimings(timings);
}

export interface WalResult {
  readonly autoCheckpointPages: number;
  readonly beforeCheckpoint: FileSizes;
  readonly passiveCheckpoint: CheckpointResult;
  readonly afterPassiveCheckpoint: FileSizes;
  readonly truncateWhileReader: CheckpointResult;
  readonly truncateCheckpoint: CheckpointResult;
  readonly afterTruncateCheckpoint: FileSizes;
  readonly readerSawCommittedRows: number;
  readonly readerBlockedWriter: boolean;
}

export interface CheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

function checkpoint(database: Database.Database, mode: "PASSIVE" | "TRUNCATE"): CheckpointResult {
  const row = (database.pragma(`wal_checkpoint(${mode})`) as Array<{ busy: number; log: number; checkpointed: number }>)[0] ?? { busy: 0, log: 0, checkpointed: 0 };
  return { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) };
}

export function runWalExperiment(root: string): WalResult {
  const databasePath = path.join(root, "wal.sqlite");
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 250");
  const autoCheckpointPages = Number(database.pragma("wal_autocheckpoint", { simple: true }));
  database.exec("CREATE TABLE values_table(value INTEGER NOT NULL)");
  database.prepare("INSERT INTO values_table(value) VALUES (1)").run();
  const reader = new Database(databasePath, { readonly: true, timeout: 250 });
  reader.pragma("busy_timeout = 250");
  reader.exec("BEGIN");
  const readerSawCommittedRows = Number((reader.prepare("SELECT COUNT(*) AS count FROM values_table").get() as { count: number }).count);
  database.transaction(() => {
    const insert = database.prepare("INSERT INTO values_table(value) VALUES (?)");
    for (let index = 0; index < 5_000; index += 1) insert.run(index + 2);
  })();
  const beforeCheckpoint = fileSizes(databasePath);
  const passiveCheckpoint = checkpoint(database, "PASSIVE");
  const afterPassiveCheckpoint = fileSizes(databasePath);
  const truncateWhileReader = checkpoint(database, "TRUNCATE");
  reader.exec("COMMIT");
  reader.close();
  const truncateCheckpoint = checkpoint(database, "TRUNCATE");
  const afterTruncateCheckpoint = fileSizes(databasePath);
  database.close();
  return { autoCheckpointPages, beforeCheckpoint, passiveCheckpoint, afterPassiveCheckpoint, truncateWhileReader, truncateCheckpoint, afterTruncateCheckpoint, readerSawCommittedRows, readerBlockedWriter: truncateWhileReader.busy === 1 };
}

interface ChildResult { readonly code: number | null; readonly stderr: string; }

function runChild(code: string, args: readonly string[]): Promise<ChildResult> {
  const child = spawn(process.execPath, ["-e", code, ...args], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ code: exitCode, stderr }));
  });
}

export interface ConcurrencyResult {
  readonly readerErrors: readonly string[];
  readonly writerErrors: readonly string[];
  readonly rowsAfterCommit: number;
  readonly originalRowsAfterRollback: number;
}

export async function runConcurrencyExperiment(root: string): Promise<ConcurrencyResult> {
  const databasePath = path.join(root, "concurrency.sqlite");
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 250");
  database.exec("CREATE TABLE values_table(value INTEGER PRIMARY KEY)");
  database.prepare("INSERT INTO values_table(value) VALUES (1)").run();
  database.close();
  const readerCode = `const Database = require('better-sqlite3'); const db = new Database(process.argv[1], { readonly: true, timeout: 250 }); try { db.exec('BEGIN'); db.prepare('SELECT COUNT(*) FROM values_table').get(); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 250); } catch (error) { console.error(String(error)); process.exitCode = 1; }`;
  const writerCode = `const Database = require('better-sqlite3'); const db = new Database(process.argv[1], { timeout: 250 }); try { db.transaction(() => { const insert = db.prepare('INSERT INTO values_table(value) VALUES (?)'); for (let i = 2; i <= 101; i += 1) insert.run(i); })(); db.close(); } catch (error) { console.error(String(error)); process.exitCode = 1; }`;
  const readers = Array.from({ length: 4 }, () => runChild(readerCode, [databasePath]));
  const writer = runChild(writerCode, [databasePath]);
  const [readerResults, writerResult] = await Promise.all([Promise.all(readers), writer]);
  const verification = new Database(databasePath);
  const rowsAfterCommit = Number((verification.prepare("SELECT COUNT(*) AS count FROM values_table").get() as { count: number }).count);
  try {
    verification.transaction(() => {
      verification.prepare("INSERT INTO values_table(value) VALUES (999)").run();
      throw new Error("intentional rollback");
    })();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "intentional rollback") throw error;
  }
  const originalRowsAfterRollback = Number((verification.prepare("SELECT COUNT(*) AS count FROM values_table").get() as { count: number }).count);
  verification.close();
  return {
    readerErrors: readerResults.flatMap((result) => result.code === 0 ? [] : [result.stderr.trim() || `exit ${result.code ?? "unknown"}`]),
    writerErrors: writerResult.code === 0 ? [] : [writerResult.stderr.trim() || `exit ${writerResult.code ?? "unknown"}`],
    rowsAfterCommit,
    originalRowsAfterRollback
  };
}

export interface BackupResult {
  readonly sourceSize: FileSizes;
  readonly backupSize: FileSizes;
  readonly sourceIntegrity: string;
  readonly backupIntegrity: string;
  readonly sourceRows: number;
  readonly backupRows: number;
  readonly sourceScoresBefore: number;
  readonly sourceScoresAfter: number;
  readonly backupScores: number;
  readonly concurrentWriterErrors: readonly string[];
  readonly concurrentBackupSnapshotConsistent: boolean;
  readonly corruptCopyRejected: boolean;
  readonly failedDestinationPreservedSource: boolean;
}

export async function runBackupExperiment(fixture: Fixture): Promise<BackupResult> {
  const source = new Database(fixture.databasePath);
  source.pragma("journal_mode = WAL");
  const backupPath = path.join(fixture.root, "consistent-backup.sqlite");
  const sourceScoresBefore = Number((source.prepare("SELECT COUNT(*) AS count FROM scores").get() as { count: number }).count);
  const writerCode = `const Database = require('better-sqlite3'); const db = new Database(process.argv[1], { timeout: 5000 }); setTimeout(() => { try { db.transaction(() => { const insert = db.prepare('INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES (?, ?, ?, ?, ?)'); for (let i = 0; i < 100; i += 1) insert.run('backup-writer', 'synthetic', i, 1700001000 + i, 'backup-test'); })(); db.close(); } catch (error) { console.error(String(error)); db.close(); process.exitCode = 1; } }, 10);`;
  const concurrentWriter = runChild(writerCode, [fixture.databasePath]);
  await source.backup(backupPath);
  const writerResult = await concurrentWriter;
  const sourceScoresAfter = Number((source.prepare("SELECT COUNT(*) AS count FROM scores").get() as { count: number }).count);
  const failedDestination = path.join(fixture.root, "missing", "backup.sqlite");
  let failedDestinationPreservedSource = false;
  try {
    await source.backup(failedDestination);
  } catch {
    failedDestinationPreservedSource = Number((source.prepare("PRAGMA integrity_check").get() as { integrity_check: string })["integrity_check"] === "ok");
  }
  const backup = new Database(backupPath, { readonly: true });
  const sourceIntegrity = String((source.prepare("PRAGMA integrity_check").get() as { integrity_check: string })["integrity_check"]);
  const backupIntegrity = String((backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string })["integrity_check"]);
  const sourceRows = Number((source.prepare("SELECT COUNT(*) AS count FROM samples").get() as { count: number }).count);
  const backupRows = Number((backup.prepare("SELECT COUNT(*) AS count FROM samples").get() as { count: number }).count);
  const backupScores = Number((backup.prepare("SELECT COUNT(*) AS count FROM scores").get() as { count: number }).count);
  const sourceSize = fileSizes(fixture.databasePath);
  const backupSize = fileSizes(backupPath);
  backup.close();
  source.close();
  const corruptPath = path.join(fixture.root, "corrupt-backup.sqlite");
  fs.copyFileSync(backupPath, corruptPath);
  const corruptHandle = fs.openSync(corruptPath, "r+");
  fs.writeSync(corruptHandle, Buffer.from("not-a-sqlite"), 0, 12, 0);
  fs.closeSync(corruptHandle);
  let corruptCopyRejected = false;
  try {
    const corrupt = new Database(corruptPath, { readonly: true });
    const integrity = String((corrupt.prepare("PRAGMA integrity_check").get() as { integrity_check: string })["integrity_check"]);
    corruptCopyRejected = integrity !== "ok";
    corrupt.close();
  } catch {
    corruptCopyRejected = true;
  }
  return {
    sourceSize,
    backupSize,
    sourceIntegrity,
    backupIntegrity,
    sourceRows,
    backupRows,
    sourceScoresBefore,
    sourceScoresAfter,
    backupScores,
    concurrentWriterErrors: writerResult.code === 0 ? [] : [writerResult.stderr.trim() || `exit ${writerResult.code ?? "unknown"}`],
    concurrentBackupSnapshotConsistent: backupScores === sourceScoresBefore || backupScores === sourceScoresAfter,
    corruptCopyRejected,
    failedDestinationPreservedSource: Boolean(failedDestinationPreservedSource)
  };
}

export interface RateLimitResult {
  readonly burstAllowed: number;
  readonly burstRejected: number;
  readonly boundedClientCount: number;
  readonly resetAllowed: boolean;
}

export function runRateLimiterExperiment(): RateLimitResult {
  const limiter = new ScoreRateLimiter(10, 60, 3, 4);
  let burstAllowed = 0;
  let burstRejected = 0;
  for (let index = 0; index < 5; index += 1) {
    if (limiter.allow("client-a", 1_000)) burstAllowed += 1;
    else burstRejected += 1;
  }
  for (let index = 0; index < 20; index += 1) limiter.allow(`client-${index}`, 2_000 + index);
  const boundedClientCount = limiter.size();
  const resetAllowed = limiter.allow("client-a", 62_000);
  return { burstAllowed, burstRejected, boundedClientCount, resetAllowed };
}
