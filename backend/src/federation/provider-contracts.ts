/** Supported federation protocol implementations. */
export type FederationProtocol = "oidc" | "saml";

/** OIDC client authentication methods accepted by the provider boundary. */
export type OidcClientAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "none";

/** Secret purposes used to resolve provider-scoped references. */
export type FederationSecretPurpose =
  | "oidc-client-secret"
  | "saml-sp-signing-private-key"
  | "saml-sp-decryption-private-key";

/** Normalized provider configuration loaded from canonical storage. */
export interface FederationProviderConfig {
  readonly providerId: string;
  readonly protocol: FederationProtocol;
  readonly displayName: string;
  readonly issuer: string;
  readonly enabled: boolean;
  readonly clientId: string | null;
  readonly clientAuthMethod: OidcClientAuthMethod;
  readonly discoveryIssuer: string | null;
  readonly redirectUri: string | null;
  readonly scopes: readonly string[];
  readonly clientSecretReference: string | null;
  readonly idpEntityId: string | null;
  readonly spEntityId: string | null;
  readonly acsUrl: string | null;
  readonly metadataReference: string | null;
  readonly trustedCertificateReference: string | null;
  readonly signingKeyReference: string | null;
  readonly samlEntryPoint: string | null;
  readonly samlNameIdFormat: string | null;
  readonly samlIdpCertificatePem: string | null;
  readonly samlTrustedCertificatesPem: readonly string[];
  readonly samlSpCertificatePem: string | null;
  readonly samlWantAssertionsSigned: boolean;
  readonly samlWantAuthnResponseSigned: boolean;
  readonly samlSignAuthnRequests: boolean;
  readonly samlAcceptedClockSkewMs: number;
  readonly samlMetadataLifecyclePolicy: "manual";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly generation: number;
}

/** Input accepted when creating or provisioning a federation provider. */
export interface ProviderInput {
  readonly providerId: string;
  readonly protocol: FederationProtocol;
  readonly displayName: string;
  readonly issuer: string;
  readonly clientId?: string;
  readonly clientAuthMethod?: OidcClientAuthMethod;
  readonly discoveryIssuer?: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly clientSecretReference?: string;
  readonly idpEntityId?: string;
  readonly spEntityId?: string;
  readonly acsUrl?: string;
  readonly metadataReference?: string;
  readonly trustedCertificateReference?: string;
  readonly signingKeyReference?: string;
  readonly samlEntryPoint?: string;
  readonly samlNameIdFormat?: string;
  readonly samlIdpCertificatePem?: string;
  readonly samlTrustedCertificatesPem?: readonly string[];
  readonly samlSpCertificatePem?: string;
  readonly samlWantAssertionsSigned?: boolean;
  readonly samlWantAuthnResponseSigned?: boolean;
  readonly samlSignAuthnRequests?: boolean;
  readonly samlAcceptedClockSkewMs?: number;
  readonly samlMetadataLifecyclePolicy?: "manual";
}

/** Audit identity attached to provider mutations. */
export interface ProviderMutationContext {
  readonly actorUserId: number;
  readonly requestId: string;
}
