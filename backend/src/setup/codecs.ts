import type { FederationProviderConfig } from "../federation/provider-contracts.js";
import { SETUP_STEPS, type SetupState, type SetupStep } from "./service-contracts.js";
import { SetupError } from "./errors.js";

/** Row shape used by the durable setup state boundary. */
export interface SetupRow {
  readonly state: SetupState;
  readonly completed_steps_json: string;
  readonly admin_user_id: number | null;
  readonly recovery_reason: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

/** Determines whether a value can be used as an installation payload. */
export function isSetupRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads a bounded string from a setup payload. */
export function setupStringValue(
  value: unknown,
  field: string,
  max = 512,
  required = false
): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new SetupError(
        "setup_invalid_value",
        400,
        `${field} is required`
      );
    }
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new SetupError(
      "setup_invalid_value",
      400,
      `${field} is invalid`
    );
  }
  return value.trim();
}

/** Reads a boolean from a setup payload while preserving its default. */
export function setupBooleanValue(
  value: unknown,
  field: string,
  fallback = false
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new SetupError(
      "setup_invalid_value",
      400,
      `${field} is invalid`
    );
  }
  return value;
}

/** Decodes persisted setup steps and discards unknown values. */
export function parseSetupSteps(value: string): SetupStep[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SetupStep =>
        typeof item === "string" &&
        (SETUP_STEPS as readonly string[]).includes(item)
    );
  } catch {
    return [];
  }
}

/** Removes secrets and sensitive provider material from setup progress. */
export function safeProviderSummary(
  provider: FederationProviderConfig
): Record<string, unknown> {
  return {
    provider_id: provider.providerId,
    protocol: provider.protocol,
    display_name: provider.displayName,
    issuer: provider.issuer,
    enabled: provider.enabled,
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    acs_url: provider.acsUrl,
    client_auth_method: provider.clientAuthMethod,
    client_secret_configured: provider.clientSecretReference !== null,
    saml_certificate_count: provider.samlTrustedCertificatesPem.length,
    updated_at: provider.updatedAt,
  };
}
