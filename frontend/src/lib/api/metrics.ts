import { requestSameOriginJson } from "./client";
import type { MetricsRun, MetricsRunDetail } from "./contracts";
import { metricsRunDetailSchema, metricsRunSchema } from "./schemas";

export function getRuns(): Promise<MetricsRun[]> {
  return requestSameOriginJson("/api/runs", undefined, metricsRunSchema.array());
}

export function getRunDetail(runId: string): Promise<MetricsRunDetail> {
  return requestSameOriginJson(`/api/runs/${encodeURIComponent(runId)}`, undefined, metricsRunDetailSchema);
}
