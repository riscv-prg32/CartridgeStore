"use client";

import {
  federationErrorMessage,
  type FederationProvider,
  type FederationProviderInput,
} from "../../lib/api/federation-admin";
import { Button } from "../ui/button";
import {
  Field,
  Notice,
} from "./presentation";
import {
  OidcProviderFields,
  SamlProviderFields,
} from "./provider-form-fields";
import { useProviderForm } from "./use-provider-form";

/** Properties shared by provider creation and provider editing forms. */
export type ProviderFormProps = {
  protocol: "oidc" | "saml";
  provider?: FederationProvider;
  onSubmit: (
    input:
      | FederationProviderInput
      | Omit<FederationProviderInput, "provider_id" | "protocol" | "issuer">,
  ) => void;
  pending: boolean;
  error?: unknown;
  onCancel: () => void;
  clearSensitive?: () => void;
};

/** Renders the protocol-specific provider configuration form. */
export function ProviderForm({
  protocol,
  provider,
  onSubmit,
  pending,
  error,
  onCancel,
  clearSensitive,
}: ProviderFormProps) {
  const {
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
  } = useProviderForm({ protocol, provider, onSubmit });
  const visibleError = formError || (error ? federationErrorMessage(error) : "");

  const handleReset = () => {
    resetSensitive();
    clearSensitive?.();
  };

  const handleCancel = () => {
    resetSensitive();
    clearSensitive?.();
    onCancel();
  };

  return (
    <form className="space-y-5" onSubmit={submit} onReset={handleReset}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Display name"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <Field
          label="Issuer"
          required
          value={issuer}
          onChange={(event) => setIssuer(event.target.value)}
          hint={
            protocol === "saml"
              ? "For SAML this must equal the IdP Entity ID."
              : "The Identity Provider issuer URL."
          }
        />
        {!provider && (
          <Field
            label="Provider ID"
            required
            pattern="[a-z][a-z0-9._-]{0,63}"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            hint="Lowercase identifier; immutable after creation."
          />
        )}
      </div>

      {protocol === "oidc" ? (
        <OidcProviderFields
          provider={provider}
          clientId={clientId}
          setClientId={(event) => setClientId(event.target.value)}
          clientAuthMethod={clientAuthMethod}
          setClientAuthMethod={setClientAuthMethod}
          clientSecret={clientSecret}
          setClientSecret={(event) => setClientSecret(event.target.value)}
          discoveryIssuer={discoveryIssuer}
          setDiscoveryIssuer={(event) =>
            setDiscoveryIssuer(event.target.value)
          }
          redirectUri={redirectUri}
          setRedirectUri={(event) => setRedirectUri(event.target.value)}
          canonicalRedirect={canonicalRedirect}
          scopes={scopes}
          setScopes={(event) => setScopes(event.target.value)}
        />
      ) : (
        <SamlProviderFields
          provider={provider}
          idpEntityId={idpEntityId}
          setIdpEntityId={(event) => setIdpEntityId(event.target.value)}
          setIssuer={(event) => setIssuer(event.target.value)}
          issuer={issuer}
          entryPoint={entryPoint}
          setEntryPoint={(event) => setEntryPoint(event.target.value)}
          spEntityId={spEntityId}
          setSpEntityId={(event) => setSpEntityId(event.target.value)}
          acsUrl={acsUrl}
          setAcsUrl={(event) => setAcsUrl(event.target.value)}
          canonicalAcs={canonicalAcs}
          certificate={certificate}
          setCertificate={(event) => setCertificate(event.target.value)}
          trustedCertificates={trustedCertificates}
          setTrustedCertificates={(event) =>
            setTrustedCertificates(event.target.value)
          }
          assertionsSigned={assertionsSigned}
          setAssertionsSigned={setAssertionsSigned}
          responsesSigned={responsesSigned}
          setResponsesSigned={setResponsesSigned}
          signRequests={signRequests}
          setSignRequests={setSignRequests}
        />
      )}

      {visibleError && <Notice error={visibleError} />}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={handleCancel}>
          Cancel
        </Button>
        <Button disabled={pending}>
          {pending ? "Saving…" : provider ? "Save changes" : "Create provider"}
        </Button>
      </div>
    </form>
  );
}
