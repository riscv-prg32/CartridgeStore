import { positiveInteger } from "./env-values.js";

/** Resolved score receiver, rate-limit and leaderboard limits. */
export interface ScoresLimitsEnvironmentConfig {
  readonly scoresMaxContentBytes: number;
  readonly scoresRateLimitMax: number;
  readonly scoresRateLimitWindowSeconds: number;
  readonly scoresRateLimitBurst: number;
  readonly scoresRateLimitMaxClients: number;
  readonly scoresMaxRows: number;
}

/** Parses score receiver and leaderboard limits. */
export function resolveScoresLimitsConfig(
  environment: NodeJS.ProcessEnv,
): ScoresLimitsEnvironmentConfig {
  return {
    scoresMaxContentBytes: positiveInteger(
      "PRG32_BACKEND_SCORES_MAX_CONTENT_BYTES",
      environment.PRG32_BACKEND_SCORES_MAX_CONTENT_BYTES,
      1024,
    ),
    scoresRateLimitMax: positiveInteger(
      "PRG32_BACKEND_SCORES_RATE_LIMIT_MAX",
      environment.PRG32_BACKEND_SCORES_RATE_LIMIT_MAX,
      120,
    ),
    scoresRateLimitWindowSeconds: positiveInteger(
      "PRG32_BACKEND_SCORES_RATE_LIMIT_WINDOW_SECONDS",
      environment.PRG32_BACKEND_SCORES_RATE_LIMIT_WINDOW_SECONDS,
      60,
    ),
    scoresRateLimitBurst: positiveInteger(
      "PRG32_BACKEND_SCORES_RATE_LIMIT_BURST",
      environment.PRG32_BACKEND_SCORES_RATE_LIMIT_BURST,
      16,
    ),
    scoresRateLimitMaxClients: positiveInteger(
      "PRG32_BACKEND_SCORES_RATE_LIMIT_MAX_CLIENTS",
      environment.PRG32_BACKEND_SCORES_RATE_LIMIT_MAX_CLIENTS,
      4096,
    ),
    scoresMaxRows: positiveInteger(
      "PRG32_BACKEND_SCORES_MAX_ROWS",
      environment.PRG32_BACKEND_SCORES_MAX_ROWS,
      100000,
    ),
  };
}
