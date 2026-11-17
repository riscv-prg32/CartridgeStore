/**
 * Safe response projection for federation administration providers.
 */

import crypto from "node:crypto";

import type { FederationProviderService } from "./provider.js";
import type { FederationProviderOperations } from "./operations.js";

/** Builds the public administration projection without exposing secrets. */
export function safeFederationProvider(
  provider: ReturnType<FederationProviderService["get"]>,
  operations: FederationProviderOperations
): Record<string, unknown> {
  const certificates = provider.samlTrustedCertificatesPem.map((certificate) => {
    const fingerprint = crypto
      .createHash("sha256")
      .update(certificate.replace(/\r\n/g, "\n").trim(), "utf8")
      .digest("hex");
    let validity: Record<string, string> = {};
    try {
      const parsed = new crypto.X509Certificate(certificate);
      validity = { valid_from: parsed.validFrom, valid_to: parsed.validTo };
    } catch {
      // Public-key fixtures do not contain certificate validity fields.
    }
    return { fingerprint, ...validity };
  });
  return {
    provider_id: provider.providerId,
    protocol: provider.protocol,
    display_name: provider.displayName,
    issuer: provider.issuer,
    enabled: provider.enabled,
    generation: provider.generation,
    created_at: provider.createdAt,
    updated_at: provider.updatedAt,
    client_id: provider.clientId,
    discovery_issuer: provider.discoveryIssuer,
    redirect_uri: provider.redirectUri,
    scopes: provider.scopes,
    idp_entity_id: provider.idpEntityId,
    sp_entity_id: provider.spEntityId,
    acs_url: provider.acsUrl,
    saml_entry_point: provider.samlEntryPoint,
    saml_name_id_format: provider.samlNameIdFormat,
    saml_want_assertions_signed: provider.samlWantAssertionsSigned,
    saml_want_authn_response_signed: provider.samlWantAuthnResponseSigned,
    saml_sign_authn_requests: provider.samlSignAuthnRequests,
    saml_accepted_clock_skew_ms: provider.samlAcceptedClockSkewMs,
    client_auth_method: provider.clientAuthMethod,
    client_secret_configured: provider.clientSecretReference !== null,
    configuration_complete:
      provider.protocol === "oidc"
        ? Boolean(
            provider.issuer &&
              provider.clientId &&
              provider.redirectUri &&
              (provider.clientAuthMethod === "none" ||
                provider.clientSecretReference !== null)
          )
        : Boolean(
            provider.idpEntityId &&
              provider.spEntityId &&
              provider.acsUrl &&
              provider.samlEntryPoint &&
              provider.samlTrustedCertificatesPem.length > 0
          ),
    pending_transactions: operations.status(provider.providerId)
      .pendingTransactions,
    certificates,
    trusted_certificate_count: certificates.length,
    trusted_certificate_capacity: 2
  };
}
