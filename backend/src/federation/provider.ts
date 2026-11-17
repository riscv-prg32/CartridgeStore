import type Database from "better-sqlite3";

import type { AdminAuditLog } from "../admin/audit.js";
import {
  type FederationProtocol,
  type FederationProviderConfig,
  type ProviderInput,
  type ProviderMutationContext,
} from "./provider-contracts.js";
import { FederationProviderError } from "./provider-codecs.js";
import { FederationProviderMutationService } from "./provider-mutations.js";
import {
  getFederationProvider,
  listFederationProviders,
  listPublicFederationProviders,
} from "./provider-records.js";

export type {
  FederationProtocol,
  FederationProviderConfig,
  FederationSecretPurpose,
  OidcClientAuthMethod,
  ProviderInput,
  ProviderMutationContext,
} from "./provider-contracts.js";
export { FederationProviderError } from "./provider-codecs.js";

/** Compatibility facade for federation-provider reads and mutations. */
export class FederationProviderService {
  private readonly mutations: FederationProviderMutationService;

  constructor(
    private readonly database: Database.Database,
    audit?: AdminAuditLog,
  ) {
    this.mutations = new FederationProviderMutationService(database, audit);
  }

  /** Creates one federation provider. */
  create(
    input: ProviderInput,
    context?: ProviderMutationContext,
    allowHttp = false,
  ): FederationProviderConfig {
    return this.mutations.create(input, context, allowHttp);
  }

  /** Normalizes provider input for provisioning workflows. */
  normalizeForProvisioning(
    input: ProviderInput,
    allowHttp = false,
  ): FederationProviderConfig {
    return this.mutations.normalizeForProvisioning(input, allowHttp);
  }

  /** Provisions a provider document atomically and idempotently. */
  provisionMany(
    inputs: readonly ProviderInput[],
    allowHttp = false,
  ): {
    readonly providers: readonly FederationProviderConfig[];
    readonly alreadyPresent: readonly string[];
  } {
    return this.mutations.provisionMany(inputs, allowHttp);
  }

  /** Updates a federation provider while preserving its identity. */
  update(
    providerIdValue: string,
    changes: Partial<
      Omit<ProviderInput, "providerId" | "protocol" | "issuer">
    >,
    context?: ProviderMutationContext,
    allowHttp = false,
  ): FederationProviderConfig {
    return this.mutations.update(
      providerIdValue,
      changes,
      context,
      allowHttp,
    );
  }

  /** Enables or disables a federation provider. */
  setEnabled(
    providerIdValue: string,
    enabled: boolean,
    context?: ProviderMutationContext,
  ): FederationProviderConfig {
    return this.mutations.setEnabled(providerIdValue, enabled, context);
  }

  /** Returns the number of unconsumed provider transactions. */
  pendingTransactionCount(providerIdValue: string): number {
    const provider = this.get(providerIdValue);
    return Number(
      (
        this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM federation_transactions " +
              "WHERE provider_id = ? AND consumed_at IS NULL AND expires_at > ?",
          )
          .get(provider.providerId, Date.now()) as { count: number }
      ).count,
    );
  }

  /** Invalidates pending transactions after a security-sensitive change. */
  bumpGeneration(
    providerIdValue: string,
    context?: ProviderMutationContext,
    action = "federation.provider.security_updated",
  ): FederationProviderConfig {
    return this.mutations.bumpGeneration(providerIdValue, context, action);
  }

  /** Updates the trusted SAML certificate set. */
  updateTrustedSamlCertificates(
    providerIdValue: string,
    certificates: readonly string[],
    context?: ProviderMutationContext,
    allowHttp = false,
  ): FederationProviderConfig {
    return this.mutations.updateTrustedSamlCertificates(
      providerIdValue,
      certificates,
      context,
      allowHttp,
    );
  }

  /** Reads one provider by its stable identifier. */
  get(providerIdValue: string): FederationProviderConfig {
    return getFederationProvider(this.database, providerIdValue);
  }

  /** Lists all configured providers. */
  list(): readonly FederationProviderConfig[] {
    return listFederationProviders(this.database);
  }

  /** Lists the public provider projection. */
  publicList(): readonly {
    provider_id: string;
    protocol: FederationProtocol;
    display_name: string;
    enabled: boolean;
  }[] {
    return listPublicFederationProviders(this.database);
  }

  /** Reads an enabled provider and optionally checks its protocol. */
  enabled(
    providerIdValue: string,
    expectedProtocol?: FederationProtocol,
  ): FederationProviderConfig {
    const provider = this.get(providerIdValue);
    if (!provider.enabled) {
      throw new FederationProviderError(
        "federation_provider_disabled",
        403,
        "federation provider is disabled",
      );
    }
    if (
      expectedProtocol !== undefined &&
      provider.protocol !== expectedProtocol
    ) {
      throw new FederationProviderError(
        "federation_provider_protocol_mismatch",
        409,
        "federation provider protocol does not match",
      );
    }
    return provider;
  }
}
