export type MetricsErrorCode =
  | "metrics_unavailable"
  | "invalid_metrics_json"
  | "invalid_metrics_payload"
  | "invalid_sample_structure"
  | "metrics_sample_limit"
  | "metrics_work_limit"
  | "metrics_payload_too_large"
  | "metrics_export_too_large"
  | "run_not_found"
  | "run_state_conflict"
  | "metrics_forbidden"
  | "metrics_storage_failed";

export class MetricsError extends Error {
  constructor(
    message: string,
    readonly code: MetricsErrorCode,
    readonly statusCode = 400,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MetricsError";
  }
}

export function publicMetricsError(error: unknown): { statusCode: number; body: Record<string, unknown> } {
  if (error instanceof MetricsError) {
    if (error.code === "metrics_unavailable") return { statusCode: 503, body: { ok: false, error: "metrics write isolation is unavailable", code: "metrics_unavailable" } };
    if (error.code === "metrics_payload_too_large") return { statusCode: 413, body: { ok: false, error: "metrics payload is too large", code: "metrics_payload_too_large" } };
    if (error.code === "run_not_found") return { statusCode: 404, body: { ok: false, error: "run_id not found", code: "run_not_found" } };
    if (error.code === "run_state_conflict") return { statusCode: 409, body: { ok: false, error: "run state conflict", code: "run_state_conflict" } };
    if (error.code === "metrics_forbidden") return { statusCode: 403, body: { ok: false, error: "forbidden" } };
    if (error.code === "metrics_export_too_large") return { statusCode: 413, body: { ok: false, error: "metrics export is too large", code: "metrics_export_too_large" } };
    if (error.code === "metrics_storage_failed") return { statusCode: 500, body: { ok: false, error: "metrics storage failed", code: "metrics_storage_failed" } };
    return { statusCode: error.statusCode, body: { ok: false, error: error.message, code: error.code } };
  }
  return { statusCode: 500, body: { ok: false, error: "metrics storage failed", code: "metrics_storage_failed" } };
}
