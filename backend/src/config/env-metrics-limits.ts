import { positiveInteger } from "./env-values.js";

/** Resolved metrics receiver and export limits. */
export interface MetricsLimitsEnvironmentConfig {
  readonly metricsMaxContentBytes: number;
  readonly metricsMaxSamplesPerRequest: number;
  readonly metricsMaxDbWork: number;
  readonly metricsMaxExportSamples: number;
}

/** Parses metrics receiver and export limits. */
export function resolveMetricsLimitsConfig(
  environment: NodeJS.ProcessEnv,
): MetricsLimitsEnvironmentConfig {
  return {
    metricsMaxContentBytes: positiveInteger(
      "PRG32_BACKEND_METRICS_MAX_CONTENT_BYTES",
      environment.PRG32_BACKEND_METRICS_MAX_CONTENT_BYTES,
      2 * 1024 * 1024,
    ),
    metricsMaxSamplesPerRequest: positiveInteger(
      "PRG32_BACKEND_METRICS_MAX_SAMPLES",
      environment.PRG32_BACKEND_METRICS_MAX_SAMPLES,
      1024,
    ),
    metricsMaxDbWork: positiveInteger(
      "PRG32_BACKEND_METRICS_MAX_DB_WORK",
      environment.PRG32_BACKEND_METRICS_MAX_DB_WORK,
      2048,
    ),
    metricsMaxExportSamples: positiveInteger(
      "PRG32_BACKEND_METRICS_MAX_EXPORT_SAMPLES",
      environment.PRG32_BACKEND_METRICS_MAX_EXPORT_SAMPLES,
      100000,
    ),
  };
}
