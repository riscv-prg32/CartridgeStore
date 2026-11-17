import { positiveInteger } from "./env-values.js";

/** Resolved SAML payload and relay-state limits. */
export interface SamlLimitsEnvironmentConfig {
  readonly samlMaxPostBytes: number;
  readonly samlMaxResponseBytes: number;
  readonly samlMaxRelayStateBytes: number;
}

/** Parses SAML payload-size limits. */
export function resolveSamlLimitsConfig(
  environment: NodeJS.ProcessEnv,
): SamlLimitsEnvironmentConfig {
  return {
    samlMaxPostBytes: positiveInteger(
      "PRG32_BACKEND_SAML_MAX_POST_BYTES",
      environment.PRG32_BACKEND_SAML_MAX_POST_BYTES,
      2 * 1024 * 1024,
    ),
    samlMaxResponseBytes: positiveInteger(
      "PRG32_BACKEND_SAML_MAX_RESPONSE_BYTES",
      environment.PRG32_BACKEND_SAML_MAX_RESPONSE_BYTES,
      1024 * 1024,
    ),
    samlMaxRelayStateBytes: positiveInteger(
      "PRG32_BACKEND_SAML_MAX_RELAY_STATE_BYTES",
      environment.PRG32_BACKEND_SAML_MAX_RELAY_STATE_BYTES,
      1024,
    ),
  };
}
