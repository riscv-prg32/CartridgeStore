export type ReviewErrorCode =
  | "review_unavailable"
  | "review_not_found"
  | "review_not_authorized"
  | "review_invalid_request"
  | "review_state_conflict"
  | "review_operation_failed";

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: ReviewErrorCode = "review_invalid_request",
    readonly statusCode = 400,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ReviewError";
  }
}

export function publicReviewError(error: unknown, rejection = false): { statusCode: number; body: Record<string, unknown> } {
  if (error instanceof ReviewError) {
    if (error.code === "review_not_found") {
      return rejection
        ? { statusCode: 400, body: { ok: false, error: "invalid request", code: "invalid_request" } }
        : { statusCode: 404, body: { ok: false, error: "submission not found" } };
    }
    if (error.code === "review_not_authorized") return { statusCode: error.statusCode, body: { ok: false, error: error.message } };
    if (error.code === "review_operation_failed") return { statusCode: 500, body: { ok: false, error: "review operation failed", code: "review_operation_failed" } };
    return { statusCode: error.statusCode, body: { ok: false, error: "invalid request", code: "invalid_request" } };
  }
  return { statusCode: 500, body: { ok: false, error: "review operation failed", code: "review_operation_failed" } };
}
