import type { FederationProviderConfig } from "../federation/provider-contracts.js";
import {
  parseSetupSteps,
  safeProviderSummary,
  type SetupRow,
} from "./codecs.js";
import type {
  SetupServiceOptions,
  SetupSession,
} from "./service-contracts.js";

/** Builds the setup progress projection returned to an authorized session. */
export function buildSetupProgress(
  row: SetupRow,
  session: SetupSession,
  settings: Record<string, unknown>,
  providers: readonly FederationProviderConfig[],
): Record<string, unknown> {
  return {
    ok: true,
    state: row.state,
    completed_steps: parseSetupSteps(row.completed_steps_json),
    admin_user_id: row.admin_user_id,
    started_at: row.started_at,
    completed_at: row.completed_at,
    csrf_token: session.csrfToken,
    settings,
    providers: providers.map((provider) => safeProviderSummary(provider)),
  };
}

/** Builds the setup status projection after infrastructure has been read. */
export function buildSetupStatus(
  options: SetupServiceOptions,
  infrastructure: Record<string, unknown>,
  row: SetupRow,
  applicationMdnsEnabled: boolean,
): Record<string, unknown> {
  const state = infrastructure.ready ? row.state : "INFRASTRUCTURE_NOT_READY";
  return {
    ok: true,
    state,
    setup_required:
      state === "INSTALLATION_REQUIRED" ||
      state === "INSTALLATION_IN_PROGRESS" ||
      state === "INSTALLATION_RECOVERY_REQUIRED",
    authorization_required:
      state !== "INSTALLATION_COMPLETE" &&
      state !== "INFRASTRUCTURE_NOT_READY",
    infrastructure,
    public_origins: {
      store: options.config.frontendPublicOrigin ?? null,
      api:
        options.config.federationPublicOrigin ??
        options.config.oidcPublicOrigin ??
        null,
    },
    mdns: {
      infrastructure_allowed: options.config.mdnsEnabled,
      application_enabled: applicationMdnsEnabled,
      effective_enabled: options.config.mdnsEnabled && applicationMdnsEnabled,
      service_type: "_prg32store._tcp.local.",
      abi: "prg32-store-discovery-1.0",
      port: options.config.mdnsPort,
      restart_required: true,
    },
  };
}
