import { requestSameOriginJson } from "./client";
import type { DownloadStats, GameDownloadStats, RunStats, ScoreStats } from "./contracts";
import { downloadStatsSchema, gameDownloadStatsSchema, runStatsSchema, scoreStatsSchema } from "./schemas";

export type DownloadStatsQuery = {
  since?: string;
  until?: string;
  granularity?: "day" | "week" | "month";
  limit?: number;
};

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  return query.toString();
}

export function getDownloadStats(params: DownloadStatsQuery = {}): Promise<DownloadStats> {
  const query = queryString(params);
  return requestSameOriginJson(`/api/stats/downloads${query ? `?${query}` : ""}`, undefined, downloadStatsSchema);
}

export function getGameDownloadStats(gameId: string, params: DownloadStatsQuery = {}): Promise<GameDownloadStats> {
  const query = queryString(params);
  return requestSameOriginJson(`/api/stats/downloads/${encodeURIComponent(gameId)}${query ? `?${query}` : ""}`, undefined, gameDownloadStatsSchema);
}

export function getScoreStats(limit = 10): Promise<ScoreStats> {
  return requestSameOriginJson(`/api/stats/scores?limit=${encodeURIComponent(String(limit))}`, undefined, scoreStatsSchema);
}

export function getRunStats(): Promise<RunStats> {
  return requestSameOriginJson("/api/stats/runs", undefined, runStatsSchema);
}
