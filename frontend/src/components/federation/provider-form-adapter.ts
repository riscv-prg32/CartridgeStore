import type {
  FederationProvider,
  FederationProviderInput,
} from "../../lib/api/federation-admin";

/** Values controlled by the federation provider form. */
export type ProviderFormValues = {
  providerId: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientAuthMethod: FederationProvider["client_auth_method"];
  clientSecret: string;
  discoveryIssuer: string;
  redirectUri: string;
  scopes: string;
  idpEntityId: string;
  spEntityId: string;
  acsUrl: string;
  entryPoint: string;
  certificate: string;
  trustedCertificates: string;
  assertionsSigned: boolean;
  responsesSigned: boolean;
  signRequests: boolean;
};

/** Return the existing validation message for the current form values. */
export function validateProviderForm(
  values: ProviderFormValues,
  protocol: "oidc" | "saml",
  provider?: FederationProvider,
): string | undefined {
  if (
    !values.displayName.trim() ||
    !values.issuer.trim() ||
    (!provider && !values.providerId.trim())
  ) {
    return "Complete the required fields.";
  }
  if (
    protocol === "oidc" &&
    values.clientAuthMethod !== "none" &&
    !provider &&
    !values.clientSecret
  ) {
    return "A client secret is required for this authentication method.";
  }
  if (
    protocol === "saml" &&
    (!values.idpEntityId ||
      !values.spEntityId ||
      !values.entryPoint ||
      !(values.certificate || values.trustedCertificates))
  ) {
    return "SAML entity IDs, SSO URL, and a trusted certificate are required.";
  }
  return undefined;
}

/** Build the existing backend payload from the controlled form values. */
export function buildProviderInput(
  values: ProviderFormValues,
  protocol: "oidc" | "saml",
  canonicalRedirect: string,
  canonicalAcs: string,
  provider?: FederationProvider,
): FederationProviderInput {
  const trustSet = (values.trustedCertificates.trim() || values.certificate.trim())
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const input: FederationProviderInput =
    protocol === "oidc"
      ? {
          provider_id: provider?.provider_id ?? values.providerId.trim(),
          protocol,
          display_name: values.displayName.trim(),
          issuer: values.issuer.trim(),
          client_id: values.clientId.trim() || undefined,
          client_auth_method: values.clientAuthMethod,
          client_secret: values.clientSecret || undefined,
          discovery_issuer: values.discoveryIssuer.trim() || undefined,
          redirect_uri: values.redirectUri.trim() || canonicalRedirect,
          scopes: values.scopes
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }
      : {
          provider_id: provider?.provider_id ?? values.providerId.trim(),
          protocol,
          display_name: values.displayName.trim(),
          issuer: values.issuer.trim() || values.idpEntityId.trim(),
          idp_entity_id: values.idpEntityId.trim(),
          sp_entity_id: values.spEntityId.trim(),
          acs_url: values.acsUrl.trim() || canonicalAcs,
          saml_entry_point: values.entryPoint.trim(),
          saml_name_id_format:
            "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
          ...(trustSet.length
            ? {
                saml_idp_certificate_pem: trustSet[0],
                saml_trusted_certificates_pem: trustSet,
              }
            : {}),
          saml_want_assertions_signed: values.assertionsSigned,
          saml_want_authn_response_signed: values.responsesSigned,
          saml_sign_authn_requests: values.signRequests,
        };

  if (!provider) return input;
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        !["provider_id", "protocol", "issuer", "client_secret"].includes(
          key,
        ),
    ),
  ) as FederationProviderInput;
}
