import { positiveInteger } from "./env-values.js";

/** Resolved HTTP timeout and request-rate settings. */
export interface HttpLimitsEnvironmentConfig {
  readonly httpRequestTimeoutMs: number;
  readonly httpKeepAliveTimeoutMs: number;
  readonly httpCatalogRateLimitMax: number;
  readonly httpDownloadRateLimitMax: number;
  readonly httpRateLimitWindowSeconds: number;
  readonly httpRateLimitMaxClients: number;
}

/** Parses HTTP timeout and rate-limit settings. */
export function resolveHttpLimitsConfig(
  environment: NodeJS.ProcessEnv,
): HttpLimitsEnvironmentConfig {
  return {
    httpRequestTimeoutMs: positiveInteger(
      "PRG32_BACKEND_HTTP_REQUEST_TIMEOUT_MS",
      environment.PRG32_BACKEND_HTTP_REQUEST_TIMEOUT_MS,
      120_000,
    ),
    httpKeepAliveTimeoutMs: positiveInteger(
      "PRG32_BACKEND_HTTP_KEEPALIVE_TIMEOUT_MS",
      environment.PRG32_BACKEND_HTTP_KEEPALIVE_TIMEOUT_MS,
      5_000,
    ),
    httpCatalogRateLimitMax: positiveInteger(
      "PRG32_BACKEND_HTTP_CATALOG_RATE_LIMIT_MAX",
      environment.PRG32_BACKEND_HTTP_CATALOG_RATE_LIMIT_MAX,
      120,
    ),
    httpDownloadRateLimitMax: positiveInteger(
      "PRG32_BACKEND_HTTP_DOWNLOAD_RATE_LIMIT_MAX",
      environment.PRG32_BACKEND_HTTP_DOWNLOAD_RATE_LIMIT_MAX,
      60,
    ),
    httpRateLimitWindowSeconds: positiveInteger(
      "PRG32_BACKEND_HTTP_RATE_LIMIT_WINDOW_SECONDS",
      environment.PRG32_BACKEND_HTTP_RATE_LIMIT_WINDOW_SECONDS,
      60,
    ),
    httpRateLimitMaxClients: positiveInteger(
      "PRG32_BACKEND_HTTP_RATE_LIMIT_MAX_CLIENTS",
      environment.PRG32_BACKEND_HTTP_RATE_LIMIT_MAX_CLIENTS,
      4096,
    ),
  };
}
