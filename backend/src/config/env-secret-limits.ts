import { positiveInteger } from "./env-values.js";

/** Resolved secret-store row limit. */
export interface SecretLimitsEnvironmentConfig {
  readonly secretMaxRows: number;
}

/** Parses the secret-store row limit. */
export function resolveSecretLimitsConfig(
  environment: NodeJS.ProcessEnv,
): SecretLimitsEnvironmentConfig {
  return {
    secretMaxRows: positiveInteger(
      "PRG32_BACKEND_SECRET_MAX_ROWS",
      environment.PRG32_BACKEND_SECRET_MAX_ROWS,
      16,
    ),
  };
}
