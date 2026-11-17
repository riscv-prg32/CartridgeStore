import type Database from "better-sqlite3";

import type { AdminAuditLog } from "../admin/audit.js";
import {
  FederationProviderError,
  rowToConfig,
  sameProvisionedProvider,
} from "./provider-codecs.js";
import {
  type FederationProviderConfig,
  type ProviderInput,
  type ProviderMutationContext,
} from "./provider-contracts.js";
import { getFederationProvider } from "./provider-records.js";
import { normalizeProvider } from "./provider-validation.js";

/** Owns transactional federation-provider mutations and their audit records. */
export class FederationProviderMutationService {
  constructor(
    private readonly database: Database.Database,
    private readonly audit?: AdminAuditLog,
  ) {}

  /** Creates one normalized provider in an immediate transaction. */
  create(
    input: ProviderInput,
    context?: ProviderMutationContext,
    allowHttp = false,
  ): FederationProviderConfig {
    const normalized = this.normalizeForProvisioning(input, allowHttp);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.insertNormalized(normalized);
      this.database.exec("COMMIT");
      this.auditMutation(
        context,
        "federation.provider.created",
        normalized.providerId,
      );
      return getFederationProvider(this.database, normalized.providerId);
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      if (this.isConstraint(error)) {
        throw new FederationProviderError(
          "federation_provider_conflict",
          409,
          "provider identity already exists",
        );
      }
      throw error;
    }
  }

  /** Normalizes provider input for provisioning and mutation workflows. */
  normalizeForProvisioning(
    input: ProviderInput,
    allowHttp = false,
  ): FederationProviderConfig {
    return normalizeProvider(input, allowHttp);
  }

  /** Provisions a provider document atomically and idempotently. */
  provisionMany(
    inputs: readonly ProviderInput[],
    allowHttp = false,
  ): {
    readonly providers: readonly FederationProviderConfig[];
    readonly alreadyPresent: readonly string[];
  } {
    const normalized = inputs.map((input) =>
      this.normalizeForProvisioning(input, allowHttp),
    );
    const providerIds = new Set<string>();
    const issuerKeys = new Set<string>();
    for (const provider of normalized) {
      if (providerIds.has(provider.providerId)) {
        throw new FederationProviderError(
          "federation_provider_duplicate",
          409,
          "provider document contains duplicate provider ids",
        );
      }
      providerIds.add(provider.providerId);
      const issuerKey = `${provider.protocol}\u0000${provider.issuer}`;
      if (issuerKeys.has(issuerKey)) {
        throw new FederationProviderError(
          "federation_provider_duplicate",
          409,
          "provider document contains duplicate provider identities",
        );
      }
      issuerKeys.add(issuerKey);
      if (
        provider.protocol === "oidc" &&
        provider.clientAuthMethod !== "none" &&
        !provider.clientSecretReference
      ) {
        throw new FederationProviderError(
          "federation_provider_secret_reference_required",
          400,
          "OIDC client secret reference is required",
        );
      }
      if (
        provider.protocol === "saml" &&
        provider.samlSignAuthnRequests &&
        !provider.signingKeyReference
      ) {
        throw new FederationProviderError(
          "federation_provider_secret_reference_required",
          400,
          "SAML signing key reference is required",
        );
      }
    }
    const alreadyPresent: string[] = [];
    try {
      this.database.exec("BEGIN IMMEDIATE");
      for (const provider of normalized) {
        const row = this.database
          .prepare("SELECT * FROM federation_providers WHERE provider_id = ?")
          .get(provider.providerId) as Record<string, unknown> | undefined;
        if (row) {
          const existing = rowToConfig(row);
          if (!sameProvisionedProvider(existing, provider)) {
            throw new FederationProviderError(
              "federation_provider_conflict",
              409,
              "existing provider does not match the explicit provisioning document",
            );
          }
          alreadyPresent.push(provider.providerId);
          continue;
        }
        const conflicting = this.database
          .prepare(
            "SELECT provider_id FROM federation_providers " +
              "WHERE protocol = ? AND issuer = ?",
          )
          .get(provider.protocol, provider.issuer) as
          | { provider_id?: string }
          | undefined;
        if (conflicting?.provider_id) {
          throw new FederationProviderError(
            "federation_provider_conflict",
            409,
            "provider issuer or entity identity is already assigned",
          );
        }
        this.insertNormalized(provider);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      if (error instanceof FederationProviderError) throw error;
      if (this.isConstraint(error)) {
        throw new FederationProviderError(
          "federation_provider_conflict",
          409,
          "provider identity already exists",
        );
      }
      throw error;
    }
    return {
      providers: normalized.map((provider) =>
        getFederationProvider(this.database, provider.providerId),
      ),
      alreadyPresent,
    };
  }

  /** Updates a provider while preserving its protocol identity. */
  update(
    providerIdValue: string,
    changes: Partial<
      Omit<ProviderInput, "providerId" | "protocol" | "issuer">
    >,
    context?: ProviderMutationContext,
    allowHttp = false,
  ): FederationProviderConfig {
    const current = getFederationProvider(this.database, providerIdValue);
    const input: ProviderInput = {
      providerId: current.providerId,
      protocol: current.protocol,
      displayName: changes.displayName ?? current.displayName,
      issuer: current.issuer,
      clientAuthMethod: changes.clientAuthMethod ?? current.clientAuthMethod,
      ...(changes.clientId === undefined
        ? current.clientId === null
          ? {}
          : { clientId: current.clientId }
        : { clientId: changes.clientId }),
      ...(changes.discoveryIssuer === undefined
        ? current.discoveryIssuer === null
          ? {}
          : { discoveryIssuer: current.discoveryIssuer }
        : { discoveryIssuer: changes.discoveryIssuer }),
      ...(changes.redirectUri === undefined
        ? current.redirectUri === null
          ? {}
          : { redirectUri: current.redirectUri }
        : { redirectUri: changes.redirectUri }),
      scopes: changes.scopes ?? current.scopes,
      ...(changes.clientSecretReference === undefined
        ? current.clientSecretReference === null
          ? {}
          : { clientSecretReference: current.clientSecretReference }
        : { clientSecretReference: changes.clientSecretReference }),
      ...(changes.idpEntityId === undefined
        ? current.idpEntityId === null
          ? {}
          : { idpEntityId: current.idpEntityId }
        : { idpEntityId: changes.idpEntityId }),
      ...(changes.spEntityId === undefined
        ? current.spEntityId === null
          ? {}
          : { spEntityId: current.spEntityId }
        : { spEntityId: changes.spEntityId }),
      ...(changes.acsUrl === undefined
        ? current.acsUrl === null
          ? {}
          : { acsUrl: current.acsUrl }
        : { acsUrl: changes.acsUrl }),
      ...(changes.metadataReference === undefined
        ? current.metadataReference === null
          ? {}
          : { metadataReference: current.metadataReference }
        : { metadataReference: changes.metadataReference }),
      ...(changes.trustedCertificateReference === undefined
        ? current.trustedCertificateReference === null
          ? {}
          : { trustedCertificateReference: current.trustedCertificateReference }
        : { trustedCertificateReference: changes.trustedCertificateReference }),
      ...(changes.signingKeyReference === undefined
        ? current.signingKeyReference === null
          ? {}
          : { signingKeyReference: current.signingKeyReference }
        : { signingKeyReference: changes.signingKeyReference }),
      ...(changes.samlEntryPoint === undefined
        ? current.samlEntryPoint === null
          ? {}
          : { samlEntryPoint: current.samlEntryPoint }
        : { samlEntryPoint: changes.samlEntryPoint }),
      ...(changes.samlNameIdFormat === undefined
        ? current.samlNameIdFormat === null
          ? {}
          : { samlNameIdFormat: current.samlNameIdFormat }
        : { samlNameIdFormat: changes.samlNameIdFormat }),
      ...(changes.samlIdpCertificatePem === undefined
        ? current.samlIdpCertificatePem === null
          ? {}
          : { samlIdpCertificatePem: current.samlIdpCertificatePem }
        : { samlIdpCertificatePem: changes.samlIdpCertificatePem }),
      samlTrustedCertificatesPem:
        changes.samlTrustedCertificatesPem ?? current.samlTrustedCertificatesPem,
      ...(changes.samlSpCertificatePem === undefined
        ? current.samlSpCertificatePem === null
          ? {}
          : { samlSpCertificatePem: current.samlSpCertificatePem }
        : { samlSpCertificatePem: changes.samlSpCertificatePem }),
      samlWantAssertionsSigned:
        changes.samlWantAssertionsSigned ?? current.samlWantAssertionsSigned,
      samlWantAuthnResponseSigned:
        changes.samlWantAuthnResponseSigned ??
        current.samlWantAuthnResponseSigned,
      samlSignAuthnRequests:
        changes.samlSignAuthnRequests ?? current.samlSignAuthnRequests,
      samlAcceptedClockSkewMs:
        changes.samlAcceptedClockSkewMs ?? current.samlAcceptedClockSkewMs,
      samlMetadataLifecyclePolicy:
        changes.samlMetadataLifecyclePolicy ??
        current.samlMetadataLifecyclePolicy,
    };
    const normalized = this.normalizeForProvisioning(input, allowHttp);
    const securityChanged =
      current.clientId !== normalized.clientId ||
      current.clientAuthMethod !== normalized.clientAuthMethod ||
      current.discoveryIssuer !== normalized.discoveryIssuer ||
      current.redirectUri !== normalized.redirectUri ||
      JSON.stringify(current.scopes) !== JSON.stringify(normalized.scopes) ||
      current.clientSecretReference !== normalized.clientSecretReference ||
      current.idpEntityId !== normalized.idpEntityId ||
      current.spEntityId !== normalized.spEntityId ||
      current.acsUrl !== normalized.acsUrl ||
      current.metadataReference !== normalized.metadataReference ||
      current.trustedCertificateReference !==
        normalized.trustedCertificateReference ||
      current.signingKeyReference !== normalized.signingKeyReference ||
      current.samlEntryPoint !== normalized.samlEntryPoint ||
      current.samlNameIdFormat !== normalized.samlNameIdFormat ||
      JSON.stringify(current.samlTrustedCertificatesPem) !==
        JSON.stringify(normalized.samlTrustedCertificatesPem) ||
      current.samlSpCertificatePem !== normalized.samlSpCertificatePem ||
      current.samlWantAssertionsSigned !==
        normalized.samlWantAssertionsSigned ||
      current.samlWantAuthnResponseSigned !==
        normalized.samlWantAuthnResponseSigned ||
      current.samlSignAuthnRequests !== normalized.samlSignAuthnRequests ||
      current.samlAcceptedClockSkewMs !== normalized.samlAcceptedClockSkewMs;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare(
          "UPDATE federation_providers SET display_name = ?, " +
            "client_id = ?, client_auth_method = ?, discovery_issuer = ?, " +
            "redirect_uri = ?, scopes_json = ?, client_secret_reference = ?, " +
            "idp_entity_id = ?, sp_entity_id = ?, acs_url = ?, " +
            "metadata_reference = ?, trusted_certificate_reference = ?, " +
            "signing_key_reference = ?, saml_entry_point = ?, " +
            "saml_name_id_format = ?, saml_idp_certificate_pem = ?, " +
            "saml_trusted_certificates_json = ?, saml_sp_certificate_pem = ?, " +
            "saml_want_assertions_signed = ?, " +
            "saml_want_authn_response_signed = ?, " +
            "saml_sign_authn_requests = ?, saml_accepted_clock_skew_ms = ?, " +
            "saml_metadata_lifecycle_policy = ?, generation = generation + ?, " +
            "updated_at = datetime('now') WHERE provider_id = ?",
        )
        .run(
          normalized.displayName,
          normalized.clientId,
          normalized.clientAuthMethod,
          normalized.discoveryIssuer,
          normalized.redirectUri,
          JSON.stringify(normalized.scopes),
          normalized.clientSecretReference,
          normalized.idpEntityId,
          normalized.spEntityId,
          normalized.acsUrl,
          normalized.metadataReference,
          normalized.trustedCertificateReference,
          normalized.signingKeyReference,
          normalized.samlEntryPoint,
          normalized.samlNameIdFormat,
          normalized.samlIdpCertificatePem,
          JSON.stringify(normalized.samlTrustedCertificatesPem),
          normalized.samlSpCertificatePem,
          normalized.samlWantAssertionsSigned ? 1 : 0,
          normalized.samlWantAuthnResponseSigned ? 1 : 0,
          normalized.samlSignAuthnRequests ? 1 : 0,
          normalized.samlAcceptedClockSkewMs,
          normalized.samlMetadataLifecyclePolicy,
          securityChanged ? 1 : 0,
          normalized.providerId,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    this.auditMutation(context, "federation.provider.updated", normalized.providerId);
    return getFederationProvider(this.database, normalized.providerId);
  }

  /** Enables or disables a provider and invalidates pending transactions. */
  setEnabled(
    providerIdValue: string,
    enabled: boolean,
    context?: ProviderMutationContext,
  ): FederationProviderConfig {
    const provider = getFederationProvider(this.database, providerIdValue);
    if (provider.enabled === enabled) return provider;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "UPDATE federation_providers SET enabled = ?, " +
            "generation = generation + 1, updated_at = datetime('now') " +
            "WHERE provider_id = ? AND enabled = ?",
        )
        .run(enabled ? 1 : 0, provider.providerId, enabled ? 0 : 1);
      if (!enabled) {
        this.database
          .prepare(
            "UPDATE federation_transactions SET consumed_at = ? " +
              "WHERE provider_id = ? AND consumed_at IS NULL",
          )
          .run(Date.now(), provider.providerId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    this.auditMutation(
      context,
      enabled
        ? "federation.provider.enabled"
        : "federation.provider.disabled",
      provider.providerId,
    );
    return getFederationProvider(this.database, provider.providerId);
  }

  /** Bumps provider security generation and consumes pending transactions. */
  bumpGeneration(
    providerIdValue: string,
    context?: ProviderMutationContext,
    action = "federation.provider.security_updated",
  ): FederationProviderConfig {
    const provider = getFederationProvider(this.database, providerIdValue);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "UPDATE federation_providers SET generation = generation + 1, " +
            "updated_at = datetime('now') WHERE provider_id = ?",
        )
        .run(provider.providerId);
      this.database
        .prepare(
          "UPDATE federation_transactions SET consumed_at = ? " +
            "WHERE provider_id = ? AND consumed_at IS NULL",
        )
        .run(Date.now(), provider.providerId);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    this.auditMutation(context, action, provider.providerId);
    return getFederationProvider(this.database, provider.providerId);
  }

  /** Updates the trusted SAML certificate set through the normal update path. */
  updateTrustedSamlCertificates(
    providerIdValue: string,
    certificates: readonly string[],
    context?: ProviderMutationContext,
    allowHttp = false,
  ): FederationProviderConfig {
    if (certificates.length < 1) {
      throw new FederationProviderError(
        "federation_provider_invalid",
        400,
        "at least one SAML trusted certificate is required",
      );
    }
    const first = certificates[0];
    if (!first) {
      throw new FederationProviderError(
        "federation_provider_invalid",
        400,
        "at least one SAML trusted certificate is required",
      );
    }
    return this.update(
      providerIdValue,
      {
        samlIdpCertificatePem: first,
        samlTrustedCertificatesPem: certificates,
      },
      context,
      allowHttp,
    );
  }

  private insertNormalized(normalized: FederationProviderConfig): void {
    this.database
      .prepare(
        "INSERT INTO federation_providers(" +
          "provider_id, protocol, display_name, issuer, client_id, " +
          "client_auth_method, discovery_issuer, redirect_uri, scopes_json, " +
          "client_secret_reference, idp_entity_id, sp_entity_id, acs_url, " +
          "metadata_reference, trusted_certificate_reference, " +
          "signing_key_reference, saml_entry_point, saml_name_id_format, " +
          "saml_idp_certificate_pem, saml_trusted_certificates_json, " +
          "saml_sp_certificate_pem, saml_want_assertions_signed, " +
          "saml_want_authn_response_signed, saml_sign_authn_requests, " +
          "saml_accepted_clock_skew_ms, saml_metadata_lifecycle_policy) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " +
          "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        normalized.providerId,
        normalized.protocol,
        normalized.displayName,
        normalized.issuer,
        normalized.clientId,
        normalized.clientAuthMethod,
        normalized.discoveryIssuer,
        normalized.redirectUri,
        JSON.stringify(normalized.scopes),
        normalized.clientSecretReference,
        normalized.idpEntityId,
        normalized.spEntityId,
        normalized.acsUrl,
        normalized.metadataReference,
        normalized.trustedCertificateReference,
        normalized.signingKeyReference,
        normalized.samlEntryPoint,
        normalized.samlNameIdFormat,
        normalized.samlIdpCertificatePem,
        JSON.stringify(normalized.samlTrustedCertificatesPem),
        normalized.samlSpCertificatePem,
        normalized.samlWantAssertionsSigned ? 1 : 0,
        normalized.samlWantAuthnResponseSigned ? 1 : 0,
        normalized.samlSignAuthnRequests ? 1 : 0,
        normalized.samlAcceptedClockSkewMs,
        normalized.samlMetadataLifecyclePolicy,
      );
  }

  private auditMutation(
    context: ProviderMutationContext | undefined,
    action: string,
    target: string,
  ): void {
    if (!context || !this.audit) return;
    this.audit.append({
      actor_user_id: context.actorUserId,
      target_type: "federation_provider",
      target_id: target,
      action,
      outcome: "committed",
      request_id: context.requestId,
    });
  }

  private isConstraint(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("SQLITE_CONSTRAINT")
    );
  }
}
