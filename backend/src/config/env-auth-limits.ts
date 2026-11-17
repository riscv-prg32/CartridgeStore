import { positiveInteger } from "./env-values.js";

/** Resolved authentication session and request limits. */
export interface AuthLimitsEnvironmentConfig {
  readonly authSessionLifetimeSeconds: number;
  readonly authRecentReauthSeconds: number;
  readonly authRateLimitMax: number;
  readonly authRateLimitWindowSeconds: number;
  readonly authRateLimitMaxClients: number;
}

/** Parses authentication lifetime and rate-limit settings. */
export function resolveAuthLimitsConfig(
  environment: NodeJS.ProcessEnv,
): AuthLimitsEnvironmentConfig {
  return {
    authSessionLifetimeSeconds: positiveInteger(
      "PRG32_BACKEND_SESSION_LIFETIME_SECONDS",
      environment.PRG32_BACKEND_SESSION_LIFETIME_SECONDS,
      8 * 60 * 60,
    ),
    authRecentReauthSeconds: positiveInteger(
      "PRG32_BACKEND_AUTH_RECENT_REAUTH_SECONDS",
      environment.PRG32_BACKEND_AUTH_RECENT_REAUTH_SECONDS,
      5 * 60,
    ),
    authRateLimitMax: positiveInteger(
      "PRG32_BACKEND_AUTH_RATE_LIMIT_MAX",
      environment.PRG32_BACKEND_AUTH_RATE_LIMIT_MAX,
      5,
    ),
    authRateLimitWindowSeconds: positiveInteger(
      "PRG32_BACKEND_AUTH_RATE_LIMIT_WINDOW_SECONDS",
      environment.PRG32_BACKEND_AUTH_RATE_LIMIT_WINDOW_SECONDS,
      60,
    ),
    authRateLimitMaxClients: positiveInteger(
      "PRG32_BACKEND_AUTH_RATE_LIMIT_MAX_CLIENTS",
      environment.PRG32_BACKEND_AUTH_RATE_LIMIT_MAX_CLIENTS,
      4096,
    ),
  };
}
