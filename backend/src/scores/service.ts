import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { ScoreError } from "./errors.js";

type DatabaseSource = Database.Database | (() => Database.Database);

export const SCORE_TEXT_MAX_BYTES = 23;
export const SCORE_MAX_VALUE = 0xffffffff;

export interface ScoreRecord {
  readonly game: string;
  readonly player: string;
  readonly score: number;
  readonly created_at: number;
  readonly submitted_by: string;
}

export interface ScoreListQuery {
  readonly game?: string;
  readonly player?: string;
  readonly limit?: string;
}

interface ScoreInput {
  readonly game: string;
  readonly player: string;
  readonly score: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class ScoreRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowSeconds: number,
    private readonly burst: number,
    private readonly maxClients: number
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const windowMs = this.windowSeconds * 1000;
    for (const [candidate, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= windowMs) this.buckets.delete(candidate);
    }
    if (!this.buckets.has(key) && this.buckets.size >= this.maxClients) {
      const oldest = [...this.buckets.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
      if (oldest) this.buckets.delete(oldest[0]);
    }

    const current = this.buckets.get(key);
    if (!current) {
      this.buckets.set(key, { tokens: Math.max(Math.min(this.burst, this.maxPerWindow) - 1, 0), updatedAt: now });
      return true;
    }
    const refill = ((now - current.updatedAt) / windowMs) * this.maxPerWindow;
    current.tokens = Math.min(Math.min(this.burst, this.maxPerWindow), current.tokens + Math.max(refill, 0));
    current.updatedAt = now;
    if (current.tokens < 1) return false;
    current.tokens -= 1;
    return true;
  }

  size(): number { return this.buckets.size; }
}

function fail(message: string, code: ConstructorParameters<typeof ScoreError>[1], statusCode = 400): never {
  throw new ScoreError(message, code, statusCode);
}

function databaseBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("expected game, player, score", "invalid_score_payload");
  }
  const payload = value as Record<string, unknown>;
  if (Object.values(payload).some((item) => item !== null && typeof item === "object")) {
    fail("score fields must be scalar values", "invalid_score_payload");
  }
  return payload;
}

function textField(payload: Record<string, unknown>, name: "game" | "player"): string {
  const value = payload[name];
  if (typeof value !== "string") fail("expected game, player, score", "invalid_score_payload");
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > SCORE_TEXT_MAX_BYTES) {
    fail("game and player must be non-empty and at most 23 UTF-8 bytes", "invalid_score_payload");
  }
  return trimmed;
}

function scoreField(payload: Record<string, unknown>): number {
  const value = payload.score;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > SCORE_MAX_VALUE) {
    fail("score must be an unsigned 32-bit integer", "invalid_score_payload");
  }
  return value;
}

export function validateScorePayload(value: unknown): ScoreInput {
  const payload = databaseBody(value);
  return { game: textField(payload, "game"), player: textField(payload, "player"), score: scoreField(payload) };
}

export class ScoresService {
  private readonly databaseSource: DatabaseSource;
  private readonly config: BackendConfig;
  private readonly writeEnabled: boolean;
  readonly rateLimiter: ScoreRateLimiter;

  constructor(options: {
    readonly config: BackendConfig;
    readonly database: DatabaseSource;
    readonly writeEnabled: boolean;
    readonly rateLimiter?: ScoreRateLimiter;
  }) {
    this.databaseSource = options.database;
    this.config = options.config;
    this.writeEnabled = options.writeEnabled;
    this.rateLimiter = options.rateLimiter ?? new ScoreRateLimiter(
      options.config.scoresRateLimitMax,
      options.config.scoresRateLimitWindowSeconds,
      options.config.scoresRateLimitBurst,
      options.config.scoresRateLimitMaxClients
    );
  }

  private get database(): Database.Database {
    return typeof this.databaseSource === "function" ? this.databaseSource() : this.databaseSource;
  }

  private ensureWrite(): void {
    if (!this.writeEnabled) fail("score write isolation is unavailable", "scores_unavailable", 503);
  }

  list(query: ScoreListQuery): ScoreRecord[] {
    const rawLimit = query.limit === undefined || query.limit === "" ? 20 : Number(query.limit);
    const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.game) { where.push("game = ?"); params.push(query.game); }
    if (query.player) { where.push("player = ?"); params.push(query.player); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.database.prepare(
      `SELECT game, player, score, created_at, submitted_by
       FROM scores ${whereSql}
       ORDER BY score DESC, created_at ASC LIMIT ?`
    ).all(...params, limit) as ScoreRecord[];
  }

  create(value: unknown, source: string, submittedBy: string): { ok: true } {
    this.ensureWrite();
    const input = validateScorePayload(value);
    if (!this.rateLimiter.allow(source)) fail("score rate limit exceeded", "score_rate_limited", 429);
    const db = this.database;
    try {
      db.exec("BEGIN IMMEDIATE");
      const count = db.prepare("SELECT COUNT(*) AS count FROM scores").get() as { count: number };
      if (count.count >= this.config.scoresMaxRows) {
        throw new ScoreError("score capacity is full", "scores_capacity_reached", 503);
      }
      db.prepare(
        "INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES (?, ?, ?, ?, ?)"
      ).run(input.game, input.player, input.score, Math.trunc(Date.now() / 1000), submittedBy);
      db.exec("COMMIT");
      return { ok: true };
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      if (error instanceof ScoreError) throw error;
      throw new ScoreError("score storage unavailable", "scores_storage_failed", 503, { cause: error });
    }
  }
}
