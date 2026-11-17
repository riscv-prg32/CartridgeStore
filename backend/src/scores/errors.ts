export type ScoreErrorCode =
  | "scores_unavailable"
  | "invalid_score_json"
  | "invalid_score_payload"
  | "score_payload_too_large"
  | "score_rate_limited"
  | "scores_capacity_reached"
  | "scores_storage_failed"
  | "csrf_failed";

export class ScoreError extends Error {
  constructor(
    message: string,
    readonly code: ScoreErrorCode,
    readonly statusCode = 400,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScoreError";
  }
}

export function publicScoreError(error: unknown): { statusCode: number; retryAfter?: number; body: Record<string, unknown> } {
  if (error instanceof ScoreError) {
    if (error.code === "scores_unavailable") {
      return { statusCode: 503, body: { ok: false, error: "score write isolation is unavailable", code: "scores_unavailable" } };
    }
    if (error.code === "score_payload_too_large") {
      return { statusCode: 413, body: { ok: false, error: "score payload is too large", code: "score_payload_too_large" } };
    }
    if (error.code === "score_rate_limited") {
      return { statusCode: 429, retryAfter: 1, body: { ok: false, error: "score rate limit exceeded", code: "score_rate_limited" } };
    }
    if (error.code === "scores_capacity_reached") {
      return { statusCode: 503, retryAfter: 60, body: { ok: false, error: "score capacity is full", code: "scores_capacity_reached" } };
    }
    if (error.code === "scores_storage_failed") {
      return { statusCode: 503, body: { ok: false, error: "score storage unavailable", code: "scores_storage_failed" } };
    }
    if (error.code === "csrf_failed") {
      return { statusCode: 403, body: { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" } };
    }
    return { statusCode: error.statusCode, body: { ok: false, error: error.message, code: error.code } };
  }
  return { statusCode: 503, body: { ok: false, error: "score storage unavailable", code: "scores_storage_failed" } };
}
