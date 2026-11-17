import { describe, expect, test } from "vitest";

import type { FederationProvider } from "../../lib/api/federation-admin";
import {
  buildProviderInput,
  validateProviderForm,
  type ProviderFormValues,
} from "./provider-form-adapter";

const values: ProviderFormValues = {
  providerId: "generic-oidc",
  displayName: "Generic OIDC",
  issuer: "https://idp.example.test",
  clientId: "client",
  clientAuthMethod: "client_secret_basic",
  clientSecret: "secret",
  discoveryIssuer: "",
  redirectUri: "",
  scopes: "openid, profile",
  idpEntityId: "",
  spEntityId: "",
  acsUrl: "",
  entryPoint: "",
  certificate: "",
  trustedCertificates: "",
  assertionsSigned: true,
  responsesSigned: true,
  signRequests: false,
};

describe("federation provider form adapter", () => {
  test("builds the OIDC creation payload with canonical redirect fallback", () => {
    expect(
      buildProviderInput(
        values,
        "oidc",
        "https://store.example.test/callback",
        "https://store.example.test/acs",
      ),
    ).toMatchObject({
      provider_id: "generic-oidc",
      protocol: "oidc",
      redirect_uri: "https://store.example.test/callback",
      scopes: ["openid", "profile"],
    });
  });

  test("preserves the SAML trust-set payload", () => {
    const samlValues = {
      ...values,
      providerId: "generic-saml",
      protocol: "saml" as const,
      issuer: "https://idp.example.test/entity",
      idpEntityId: "https://idp.example.test/entity",
      spEntityId: "https://store.example.test/entity",
      entryPoint: "https://idp.example.test/sso",
      trustedCertificates: "PEM-A\n\nPEM-B",
    };
    expect(
      buildProviderInput(
        samlValues,
        "saml",
        "https://store.example.test/callback",
        "https://store.example.test/acs",
      ),
    ).toMatchObject({
      protocol: "saml",
      saml_idp_certificate_pem: "PEM-A",
      saml_trusted_certificates_pem: ["PEM-A", "PEM-B"],
    });
  });

  test("omits immutable and sensitive fields for provider updates", () => {
    const provider = { provider_id: "generic-oidc" } as FederationProvider;
    const update = buildProviderInput(
      values,
      "oidc",
      "https://store.example.test/callback",
      "https://store.example.test/acs",
      provider,
    );
    expect(update).not.toHaveProperty("provider_id");
    expect(update).not.toHaveProperty("protocol");
    expect(update).not.toHaveProperty("issuer");
    expect(update).not.toHaveProperty("client_secret");
    expect(validateProviderForm(values, "oidc", provider)).toBeUndefined();
  });
});
