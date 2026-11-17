"use client";

import { useState, type FormEvent } from "react";

import type {
  FederationProvider,
  FederationProviderInput,
} from "../../lib/api/federation-admin";
import { publicApiPath } from "../../lib/api/origin";
import {
  buildProviderInput,
  validateProviderForm,
  type ProviderFormValues,
} from "./provider-form-adapter";

type ProviderFormOptions = {
  protocol: "oidc" | "saml";
  provider?: FederationProvider;
  onSubmit: (
    input:
      | FederationProviderInput
      | Omit<FederationProviderInput, "provider_id" | "protocol" | "issuer">,
  ) => void;
};

/** Owns provider form state and preserves the existing submission payloads. */
export function useProviderForm({
  protocol,
  provider,
  onSubmit,
}: ProviderFormOptions) {
  const [providerId, setProviderId] = useState(provider?.provider_id ?? "");
  const [displayName, setDisplayName] = useState(provider?.display_name ?? "");
  const [issuer, setIssuer] = useState(provider?.issuer ?? "");
  const [clientId, setClientId] = useState(provider?.client_id ?? "");
  const [clientAuthMethod, setClientAuthMethod] = useState<
    FederationProvider["client_auth_method"]
  >(provider?.client_auth_method ?? "client_secret_basic");
  const [clientSecret, setClientSecret] = useState("");
  const [discoveryIssuer, setDiscoveryIssuer] = useState(
    provider?.discovery_issuer ?? "",
  );
  const [redirectUri, setRedirectUri] = useState(
    provider?.redirect_uri ?? "",
  );
  const [scopes, setScopes] = useState(
    provider?.scopes.join(", ") ?? "openid, profile",
  );
  const [idpEntityId, setIdpEntityId] = useState(
    provider?.idp_entity_id ?? "",
  );
  const [spEntityId, setSpEntityId] = useState(provider?.sp_entity_id ?? "");
  const [acsUrl, setAcsUrl] = useState(provider?.acs_url ?? "");
  const [entryPoint, setEntryPoint] = useState(
    provider?.saml_entry_point ?? "",
  );
  const [certificate, setCertificate] = useState("");
  const [trustedCertificates, setTrustedCertificates] = useState("");
  const [assertionsSigned, setAssertionsSigned] = useState(
    provider?.saml_want_assertions_signed ?? true,
  );
  const [responsesSigned, setResponsesSigned] = useState(
    provider?.saml_want_authn_response_signed ?? true,
  );
  const [signRequests, setSignRequests] = useState(
    provider?.saml_sign_authn_requests ?? false,
  );
  const [formError, setFormError] = useState("");

  const publicOrigin = publicApiPath("/").replace(/\/$/, "");
  const canonicalRedirect = `${publicOrigin}/api/auth/oidc/${encodeURIComponent(
    providerId || "<provider-id>",
  )}/callback`;
  const canonicalAcs = `${publicOrigin}/api/auth/saml/${encodeURIComponent(
    providerId || "<provider-id>",
  )}/acs`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    const values: ProviderFormValues = {
      providerId,
      displayName,
      issuer,
      clientId,
      clientAuthMethod,
      clientSecret,
      discoveryIssuer,
      redirectUri,
      scopes,
      idpEntityId,
      spEntityId,
      acsUrl,
      entryPoint,
      certificate,
      trustedCertificates,
      assertionsSigned,
      responsesSigned,
      signRequests,
    };
    const validationError = validateProviderForm(values, protocol, provider);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    onSubmit(
      buildProviderInput(
        values,
        protocol,
        canonicalRedirect,
        canonicalAcs,
        provider,
      ),
    );
  };

  const resetSensitive = () => {
    setClientSecret("");
    setCertificate("");
  };

  return {
    providerId,
    setProviderId,
    displayName,
    setDisplayName,
    issuer,
    setIssuer,
    clientId,
    setClientId,
    clientAuthMethod,
    setClientAuthMethod,
    clientSecret,
    setClientSecret,
    discoveryIssuer,
    setDiscoveryIssuer,
    redirectUri,
    setRedirectUri,
    scopes,
    setScopes,
    idpEntityId,
    setIdpEntityId,
    spEntityId,
    setSpEntityId,
    acsUrl,
    setAcsUrl,
    entryPoint,
    setEntryPoint,
    certificate,
    setCertificate,
    trustedCertificates,
    setTrustedCertificates,
    assertionsSigned,
    setAssertionsSigned,
    responsesSigned,
    setResponsesSigned,
    signRequests,
    setSignRequests,
    formError,
    canonicalRedirect,
    canonicalAcs,
    resetSensitive,
    submit,
  };
}
