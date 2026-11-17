import { requestSameOriginJson } from "./client";
import type { ScoreRecord } from "./contracts";
import { scoresSchema } from "./schemas";

export type ScoreQuery = {
  game?: string;
  player?: string;
  limit?: number;
};

export function getScores(params: ScoreQuery = {}): Promise<ScoreRecord[]> {
  const query = new URLSearchParams();
  if (params.game?.trim()) query.set("game", params.game.trim());
  if (params.player?.trim()) query.set("player", params.player.trim());
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return requestSameOriginJson(`/api/scores${suffix ? `?${suffix}` : ""}`, undefined, scoresSchema);
}
