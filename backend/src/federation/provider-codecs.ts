import type {
  FederationProtocol,
  FederationProviderConfig,
  OidcClientAuthMethod,
} from "./provider-contracts.js";

/** Public error contract emitted by federation provider operations. */
export class FederationProviderError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "FederationProviderError";
  }
}

/** Normalizes the supported OIDC client authentication methods. */
export function clientAuthMethod(value: unknown): OidcClientAuthMethod {
  if (value === undefined || value === null) return "client_secret_basic";
  if (
    value !== "client_secret_basic" &&
    value !== "client_secret_post" &&
    value !== "none"
  ) {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "client_auth_method is invalid",
    );
  }
  return value;
}

/** Decodes a persisted provider row into the public provider contract. */
export function rowToConfig(
  row: Record<string, unknown>,
): FederationProviderConfig {
  const parsedScopes =
    typeof row.scopes_json === "string"
      ? (JSON.parse(row.scopes_json) as unknown)
      : [];
  let parsedTrusted: unknown = null;
  if (typeof row.saml_trusted_certificates_json === "string") {
    try {
      parsedTrusted = JSON.parse(
        row.saml_trusted_certificates_json,
      ) as unknown;
    } catch {
      parsedTrusted = null;
    }
  }
  const legacyCertificate =
    typeof row.saml_idp_certificate_pem === "string"
      ? row.saml_idp_certificate_pem
      : null;
  const trustedCertificates = Array.isArray(parsedTrusted)
    ? parsedTrusted.filter((item): item is string => typeof item === "string")
    : legacyCertificate === null
      ? []
      : [legacyCertificate];

  return {
    providerId: String(row.provider_id),
    protocol: row.protocol as FederationProtocol,
    displayName: String(row.display_name),
    issuer: String(row.issuer),
    enabled: Number(row.enabled) === 1,
    clientId: typeof row.client_id === "string" ? row.client_id : null,
    clientAuthMethod: clientAuthMethod(row.client_auth_method),
    discoveryIssuer:
      typeof row.discovery_issuer === "string" ? row.discovery_issuer : null,
    redirectUri:
      typeof row.redirect_uri === "string" ? row.redirect_uri : null,
    scopes: Array.isArray(parsedScopes)
      ? parsedScopes.filter((item): item is string => typeof item === "string")
      : [],
    clientSecretReference:
      typeof row.client_secret_reference === "string"
        ? row.client_secret_reference
        : null,
    idpEntityId:
      typeof row.idp_entity_id === "string" ? row.idp_entity_id : null,
    spEntityId:
      typeof row.sp_entity_id === "string" ? row.sp_entity_id : null,
    acsUrl: typeof row.acs_url === "string" ? row.acs_url : null,
    metadataReference:
      typeof row.metadata_reference === "string"
        ? row.metadata_reference
        : null,
    trustedCertificateReference:
      typeof row.trusted_certificate_reference === "string"
        ? row.trusted_certificate_reference
        : null,
    signingKeyReference:
      typeof row.signing_key_reference === "string"
        ? row.signing_key_reference
        : null,
    samlEntryPoint:
      typeof row.saml_entry_point === "string" ? row.saml_entry_point : null,
    samlNameIdFormat:
      typeof row.saml_name_id_format === "string"
        ? row.saml_name_id_format
        : null,
    samlIdpCertificatePem: legacyCertificate,
    samlTrustedCertificatesPem: trustedCertificates,
    samlSpCertificatePem:
      typeof row.saml_sp_certificate_pem === "string"
        ? row.saml_sp_certificate_pem
        : null,
    samlWantAssertionsSigned: Number(row.saml_want_assertions_signed) === 1,
    samlWantAuthnResponseSigned:
      Number(row.saml_want_authn_response_signed) === 1,
    samlSignAuthnRequests: Number(row.saml_sign_authn_requests) === 1,
    samlAcceptedClockSkewMs: Number(row.saml_accepted_clock_skew_ms ?? 0),
    samlMetadataLifecyclePolicy: "manual",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    generation: Math.max(1, Number(row.generation ?? 1)),
  };
}

/** Compares the immutable provider fields used by explicit provisioning. */
export function sameProvisionedProvider(
  left: FederationProviderConfig,
  right: FederationProviderConfig,
): boolean {
  const fields: Array<keyof FederationProviderConfig> = [
    "providerId",
    "protocol",
    "displayName",
    "issuer",
    "clientId",
    "clientAuthMethod",
    "discoveryIssuer",
    "redirectUri",
    "scopes",
    "clientSecretReference",
    "idpEntityId",
    "spEntityId",
    "acsUrl",
    "metadataReference",
    "trustedCertificateReference",
    "signingKeyReference",
    "samlEntryPoint",
    "samlNameIdFormat",
    "samlIdpCertificatePem",
    "samlTrustedCertificatesPem",
    "samlSpCertificatePem",
    "samlWantAssertionsSigned",
    "samlWantAuthnResponseSigned",
    "samlSignAuthnRequests",
    "samlAcceptedClockSkewMs",
    "samlMetadataLifecyclePolicy",
  ];
  return fields.every(
    (field) => JSON.stringify(left[field]) === JSON.stringify(right[field]),
  );
}
