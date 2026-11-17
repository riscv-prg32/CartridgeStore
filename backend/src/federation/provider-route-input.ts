/**
 * Provider input normalization for federation administration routes.
 */

import {
  FederationProviderError,
  type FederationProtocol,
  type ProviderInput
} from "./provider.js";

const PROVIDER_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/** Validates a federation provider identifier. */
export function providerId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_ID_RE.test(value)) {
    throw new FederationProviderError(
      "invalid_identifier",
      400,
      "provider_id is invalid"
    );
  }
  return value;
}

/** Reads a bounded provider text field. */
export function text(
  value: unknown,
  field: string,
  max: number,
  required = false
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      `${field} is invalid`
    );
  }
  return value.trim();
}

/** Validates one of the supported federation protocols. */
export function protocol(value: unknown): FederationProtocol {
  if (value !== "oidc" && value !== "saml") {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "protocol is invalid"
    );
  }
  return value;
}

/** Converts API field names to the provider service input shape. */
export function providerInput(
  value: Record<string, unknown>,
  requireIdentity = true
): ProviderInput {
  const provider = {
    providerId: providerId(value.provider_id),
    protocol: protocol(value.protocol),
    displayName: text(value.display_name, "display_name", 160, true) as string,
    issuer: text(value.issuer, "issuer", 512, true) as string,
    ...(value.client_id === undefined
      ? {}
      : { clientId: text(value.client_id, "client_id", 240) }),
    ...(value.client_auth_method === undefined
      ? {}
      : {
          clientAuthMethod: value.client_auth_method as ProviderInput["clientAuthMethod"]
        }),
    ...(value.discovery_issuer === undefined
      ? {}
      : {
          discoveryIssuer: text(
            value.discovery_issuer,
            "discovery_issuer",
            512
          )
        }),
    ...(value.redirect_uri === undefined
      ? {}
      : { redirectUri: text(value.redirect_uri, "redirect_uri", 512) }),
    ...(value.scopes === undefined
      ? {}
      : { scopes: value.scopes as readonly string[] }),
    ...(value.idp_entity_id === undefined
      ? {}
      : { idpEntityId: text(value.idp_entity_id, "idp_entity_id", 512) }),
    ...(value.sp_entity_id === undefined
      ? {}
      : { spEntityId: text(value.sp_entity_id, "sp_entity_id", 512) }),
    ...(value.acs_url === undefined
      ? {}
      : { acsUrl: text(value.acs_url, "acs_url", 512) }),
    ...(value.saml_entry_point === undefined
      ? {}
      : {
          samlEntryPoint: text(value.saml_entry_point, "saml_entry_point", 512)
        }),
    ...(value.saml_name_id_format === undefined
      ? {}
      : {
          samlNameIdFormat: text(
            value.saml_name_id_format,
            "saml_name_id_format",
            160
          )
        }),
    ...(value.saml_idp_certificate_pem === undefined
      ? {}
      : {
          samlIdpCertificatePem: text(
            value.saml_idp_certificate_pem,
            "saml_idp_certificate_pem",
            65536
          )
        }),
    ...(value.saml_trusted_certificates_pem === undefined
      ? {}
      : {
          samlTrustedCertificatesPem:
            value.saml_trusted_certificates_pem as readonly string[]
        }),
    ...(value.saml_sp_certificate_pem === undefined
      ? {}
      : {
          samlSpCertificatePem: text(
            value.saml_sp_certificate_pem,
            "saml_sp_certificate_pem",
            65536
          )
        }),
    ...(value.saml_want_assertions_signed === undefined
      ? {}
      : {
          samlWantAssertionsSigned:
            value.saml_want_assertions_signed as boolean
        }),
    ...(value.saml_want_authn_response_signed === undefined
      ? {}
      : {
          samlWantAuthnResponseSigned:
            value.saml_want_authn_response_signed as boolean
        }),
    ...(value.saml_sign_authn_requests === undefined
      ? {}
      : {
          samlSignAuthnRequests: value.saml_sign_authn_requests as boolean
        }),
    ...(value.saml_accepted_clock_skew_ms === undefined
      ? {}
      : {
          samlAcceptedClockSkewMs:
            value.saml_accepted_clock_skew_ms as number
        }),
    ...(value.signing_key_reference === undefined
      ? {}
      : {
          signingKeyReference: text(
            value.signing_key_reference,
            "signing_key_reference",
            240
          )
        })
  } as ProviderInput;
  if (
    requireIdentity &&
    provider.protocol === "saml" &&
    (!provider.idpEntityId || !provider.spEntityId)
  ) {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "SAML entity identifiers are required"
    );
  }
  return provider;
}
