export type SubmissionErrorCode =
  | "submission_unavailable"
  | "authentication_required"
  | "csrf_failed"
  | "invalid_request"
  | "submission_payload_too_large"
  | "submission_storage_failed";

export class SubmissionError extends Error {
  constructor(
    message: string,
    readonly code: SubmissionErrorCode = "invalid_request",
    readonly statusCode = 400,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SubmissionError";
  }
}

export function publicSubmissionError(error: unknown): { statusCode: number; body: Record<string, unknown> } {
  if (error instanceof SubmissionError) {
    if (error.code === "invalid_request") {
      return { statusCode: error.statusCode, body: { ok: false, error: "invalid request", code: "invalid_request" } };
    }
    if (error.code === "submission_payload_too_large") {
      return { statusCode: error.statusCode, body: { ok: false, error: "upload is too large" } };
    }
    return {
      statusCode: error.statusCode,
      body: { ok: false, error: error.message, code: error.code }
    };
  }
  return {
    statusCode: 500,
    body: { ok: false, error: "submission operation failed", code: "submission_storage_failed" }
  };
}
