import type Database from "better-sqlite3";

import type { ReadonlyDatabaseManager } from "../db/readonly.js";

type DatabaseSource = Database.Database | ReadonlyDatabaseManager;

export interface StatsCatalogSource {
  listGames(query?: string): Record<string, unknown>[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

export type StatsGranularity = "day" | "week" | "month";

export interface StatsQuery {
  readonly since?: string;
  readonly until?: string;
  readonly granularity?: string;
  readonly limit?: string;
}

interface ParsedDownloadQuery {
  readonly since?: string;
  readonly until?: string;
  readonly granularity: StatsGranularity;
  readonly limit: number;
}

interface DownloadSeriesRow {
  readonly bucket: string | null;
  readonly downloads: number;
}

interface DownloadCountRow {
  readonly total: number;
}

interface TopGameRow {
  readonly game_id: string;
  readonly downloads: number;
}

interface ArchitectureRow {
  readonly architecture: string;
  readonly downloads: number;
}

interface ScoreRow {
  readonly game: string;
  readonly player: string;
  readonly score: number;
  readonly created_at: number;
  readonly submitted_by: string;
}

interface RunCountRow {
  readonly count: number;
}

function optionalDate(value: string | undefined): string | undefined {
  const candidate = value?.trim() ?? "";
  return candidate && DATE_PATTERN.test(candidate) ? candidate : undefined;
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const candidate = value.trim();
  if (!/^[+-]?\d+$/.test(candidate)) return fallback;
  try {
    const parsed = BigInt(candidate);
    if (parsed < 1n) return 1;
    if (parsed > BigInt(maximum)) return maximum;
    return Number(parsed);
  } catch {
    return fallback;
  }
}

function granularity(value: string | undefined): StatsGranularity {
  const candidate = value?.trim().toLowerCase();
  if (candidate === "week" || candidate === "month") return candidate;
  return "day";
}

function periodExpression(value: StatsGranularity): string {
  if (value === "month") return "substr(downloaded_at, 1, 7) || '-01'";
  if (value === "week") return "date(downloaded_at, 'weekday 0', '-6 days')";
  return "date(downloaded_at)";
}

function parseDownloadQuery(query: StatsQuery): ParsedDownloadQuery {
  const since = optionalDate(query.since);
  const until = optionalDate(query.until);
  return {
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    granularity: granularity(query.granularity),
    limit: boundedInteger(query.limit, 30, 365)
  };
}

function filters(query: ParsedDownloadQuery, gameId: string | undefined, gameColumn: "game_id" | "cartridge_id"): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.since) {
    clauses.push("date(downloaded_at) >= date(?)");
    params.push(query.since);
  }
  if (query.until) {
    clauses.push("date(downloaded_at) <= date(?)");
    params.push(query.until);
  }
  if (gameId) {
    clauses.push(`${gameColumn} = ?`);
    params.push(gameId);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function catalogLookup(catalog: StatsCatalogSource): Map<string, Record<string, unknown>> {
  try {
    return new Map(catalog.listGames().map((game) => [String(game.id), game]));
  } catch {
    // Preserve the historical aggregate row when a catalog entry is unavailable
    // or malformed.
    return new Map();
  }
}

export interface DownloadSummary {
  readonly series: Array<{ date: string; downloads: number }>;
  readonly total: number;
  readonly top_games: Array<{ id: string; title: string; downloads: number; last_published: unknown }>;
}

export interface GameDownloadBreakdown {
  readonly id: string;
  readonly total: number;
  readonly architectures: Array<{ architecture: string; downloads: number }>;
  readonly series: Array<{ date: string; downloads: number }>;
}

export class StatsService {
  constructor(
    private readonly database: DatabaseSource,
    private readonly catalog: StatsCatalogSource,
    private readonly canonicalMode = false,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  private get sqlite(): Database.Database {
    return "get" in this.database ? this.database.get().sqlite : this.database;
  }

  private get gameColumn(): "game_id" | "cartridge_id" {
    return this.canonicalMode ? "cartridge_id" : "game_id";
  }

  private series(query: ParsedDownloadQuery, gameId?: string): Array<{ date: string; downloads: number }> {
    const where = filters(query, gameId, this.gameColumn);
    const rows = this.sqlite.prepare(
      `SELECT ${periodExpression(query.granularity)} AS bucket, COUNT(*) AS downloads
       FROM download_events
       ${where.sql}
       GROUP BY bucket
       ORDER BY bucket DESC
       LIMIT ?`
    ).all(...where.params, query.limit) as DownloadSeriesRow[];
    return rows.reverse().map((row) => ({
      date: String(row.bucket),
      downloads: Number(row.downloads)
    }));
  }

  downloadSummary(input: StatsQuery, gameId?: string): DownloadSummary {
    const query = parseDownloadQuery(input);
    const where = filters(query, gameId, this.gameColumn);
    const series = this.series(query, gameId);
    const total = this.sqlite.prepare(
      `SELECT COUNT(*) AS total FROM download_events ${where.sql}`
    ).get(...where.params) as DownloadCountRow;
    const topGames = this.sqlite.prepare(
      `SELECT ${this.gameColumn} AS game_id, COUNT(*) AS downloads
       FROM download_events
       ${where.sql}
       GROUP BY game_id
       ORDER BY downloads DESC, game_id ASC
       LIMIT 10`
    ).all(...where.params) as TopGameRow[];
    const games = catalogLookup(this.catalog);

    return {
      series,
      total: Number(total.total),
      top_games: topGames.map((row) => {
        const game = games.get(row.game_id);
        return {
          id: row.game_id,
          title: typeof game?.title === "string" ? game.title : row.game_id,
          downloads: Number(row.downloads),
          last_published: game && Object.hasOwn(game, "updated_at") ? game.updated_at : ""
        };
      })
    };
  }

  gameDownloadBreakdown(gameId: string, input: StatsQuery): GameDownloadBreakdown {
    const rows = this.sqlite.prepare(
      `SELECT architecture, COUNT(*) AS downloads
       FROM download_events
       WHERE ${this.gameColumn} = ?
       GROUP BY architecture
       ORDER BY downloads DESC, architecture ASC`
    ).all(gameId) as ArchitectureRow[];
    return {
      id: gameId,
      total: rows.reduce((total, row) => total + Number(row.downloads), 0),
      architectures: rows.map((row) => ({ architecture: row.architecture, downloads: Number(row.downloads) })),
      series: this.series(parseDownloadQuery(input), gameId)
    };
  }

  scoreStats(limitValue: string | undefined): { scores: ScoreRow[] } {
    const limit = boundedInteger(limitValue, 20, 100);
    const scores = this.sqlite.prepare(
      `SELECT game, player, score, created_at, submitted_by
       FROM scores
       ORDER BY score DESC, created_at ASC
       LIMIT ?`
    ).all(limit) as ScoreRow[];
    return { scores };
  }

  runStats(): { total: number; finished: number; active_last_7_days: number } {
    const total = this.sqlite.prepare("SELECT COUNT(*) AS count FROM runs").get() as RunCountRow;
    const finished = this.sqlite.prepare("SELECT COUNT(*) AS count FROM runs WHERE finished_at IS NOT NULL").get() as RunCountRow;
    const cutoff = this.nowSeconds() - WEEK_SECONDS;
    const active = this.sqlite.prepare("SELECT COUNT(*) AS count FROM runs WHERE created_at >= ?").get(cutoff) as RunCountRow;
    return {
      total: Number(total.count),
      finished: Number(finished.count),
      active_last_7_days: Number(active.count)
    };
  }
}
