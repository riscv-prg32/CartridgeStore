import type Database from "better-sqlite3";

import type { FederationProtocol, FederationProviderConfig } from "./provider-contracts.js";
import {
  FederationProviderError,
  rowToConfig,
} from "./provider-codecs.js";
import { normalizeProviderId } from "./provider-validation.js";

/** Loads one provider configuration from the federation store. */
export function getFederationProvider(
  database: Database.Database,
  providerIdValue: string,
): FederationProviderConfig {
  const providerId = normalizeProviderId(providerIdValue);
  const row = database
    .prepare("SELECT * FROM federation_providers WHERE provider_id = ?")
    .get(providerId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new FederationProviderError(
      "federation_provider_unknown",
      404,
      "federation provider is unknown",
    );
  }
  return rowToConfig(row);
}

/** Lists complete federation provider configurations in stable order. */
export function listFederationProviders(
  database: Database.Database,
): readonly FederationProviderConfig[] {
  return (
    database
      .prepare(
        "SELECT * FROM federation_providers ORDER BY provider_id ASC",
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => rowToConfig(row));
}

/** Lists the public provider projection used by discovery and login screens. */
export function listPublicFederationProviders(
  database: Database.Database,
): readonly {
  provider_id: string;
  protocol: FederationProtocol;
  display_name: string;
  enabled: boolean;
}[] {
  return (
    database
      .prepare(
        "SELECT provider_id, protocol, display_name, enabled " +
          "FROM federation_providers ORDER BY provider_id ASC",
      )
      .all() as Array<{
      provider_id: string;
      protocol: FederationProtocol;
      display_name: string;
      enabled: number;
    }>
  ).map((row) => ({
    provider_id: row.provider_id,
    protocol: row.protocol,
    display_name: row.display_name,
    enabled: row.enabled === 1,
  }));
}
