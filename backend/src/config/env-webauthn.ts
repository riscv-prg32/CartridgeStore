import {
  booleanValue,
  nonEmpty,
  optionalNonEmpty,
} from "./env-values.js";

/** Resolved WebAuthn and setup network configuration. */
export interface WebAuthnEnvironmentConfig {
  readonly webauthnEnabled: boolean;
  readonly webauthnRpId: string | undefined;
  readonly webauthnRpName: string;
  readonly webauthnOrigins: readonly string[];
  readonly setupNetworkTestAllowlist: readonly string[];
}

/** Parses and validates WebAuthn relying-party and origin settings. */
export function resolveWebAuthnConfig(
  environment: NodeJS.ProcessEnv,
  authWriteEnabled: boolean,
): WebAuthnEnvironmentConfig {
  const webauthnEnabled = booleanValue(
    "PRG32_BACKEND_WEBAUTHN_ENABLED",
    environment.PRG32_BACKEND_WEBAUTHN_ENABLED,
    false,
  );
  const webauthnRpId = optionalNonEmpty(
    environment.PRG32_BACKEND_WEBAUTHN_RP_ID,
  );
  const webauthnRpName = nonEmpty(
    "PRG32_BACKEND_WEBAUTHN_RP_NAME",
    environment.PRG32_BACKEND_WEBAUTHN_RP_NAME,
    "PRG32 Cartridge Store",
  );
  const webauthnOrigins = (
    environment.PRG32_BACKEND_WEBAUTHN_ORIGINS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const setupNetworkTestAllowlist = (
    environment.PRG32_BACKEND_SETUP_NETWORK_TEST_ALLOWLIST ?? ""
  )
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (webauthnEnabled) {
    if (!authWriteEnabled) {
      throw new Error("WebAuthn requires the canonical authentication writer");
    }
    if (!webauthnRpId || webauthnOrigins.length === 0) {
      throw new Error(
        "WebAuthn requires an explicit RP ID and origin allowlist",
      );
    }
    if (
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(webauthnRpId) ||
      webauthnRpId.includes("..")
    ) {
      throw new Error("PRG32_BACKEND_WEBAUTHN_RP_ID is invalid");
    }
    const allowInsecure =
      (environment.NODE_ENV ?? "").trim().toLowerCase() === "test";
    for (const origin of webauthnOrigins) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error(
          "PRG32_BACKEND_WEBAUTHN_ORIGINS contains an invalid origin",
        );
      }
      if (
        (!allowInsecure && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error("WebAuthn origins must be trusted HTTPS origins");
      }
      if (
        parsed.hostname !== webauthnRpId &&
        !parsed.hostname.endsWith(`.${webauthnRpId}`)
      ) {
        throw new Error(
          "WebAuthn RP ID is not compatible with every configured origin",
        );
      }
    }
  }
  return {
    webauthnEnabled,
    webauthnRpId,
    webauthnRpName,
    webauthnOrigins,
    setupNetworkTestAllowlist,
  };
}
