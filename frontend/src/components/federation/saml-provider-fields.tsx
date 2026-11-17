"use client";

import type { ChangeEventHandler } from "react";

import type { FederationProvider } from "../../lib/api/federation-admin";
import {
  Field,
  TextArea,
} from "./presentation";

/** Controlled values and setters for SAML provider fields. */
export interface SamlProviderFieldsProps {
  readonly provider?: FederationProvider;
  readonly idpEntityId: string;
  readonly setIdpEntityId: ChangeEventHandler<HTMLInputElement>;
  readonly setIssuer: ChangeEventHandler<HTMLInputElement>;
  readonly issuer: string;
  readonly entryPoint: string;
  readonly setEntryPoint: ChangeEventHandler<HTMLInputElement>;
  readonly spEntityId: string;
  readonly setSpEntityId: ChangeEventHandler<HTMLInputElement>;
  readonly acsUrl: string;
  readonly setAcsUrl: ChangeEventHandler<HTMLInputElement>;
  readonly canonicalAcs: string;
  readonly certificate: string;
  readonly setCertificate: ChangeEventHandler<HTMLTextAreaElement>;
  readonly trustedCertificates: string;
  readonly setTrustedCertificates: ChangeEventHandler<HTMLTextAreaElement>;
  readonly assertionsSigned: boolean;
  readonly setAssertionsSigned: (value: boolean) => void;
  readonly responsesSigned: boolean;
  readonly setResponsesSigned: (value: boolean) => void;
  readonly signRequests: boolean;
  readonly setSignRequests: (value: boolean) => void;
}

/** Renders the controlled SAML-specific provider fields. */
export function SamlProviderFields({
  provider,
  idpEntityId,
  setIdpEntityId,
  setIssuer,
  issuer,
  entryPoint,
  setEntryPoint,
  spEntityId,
  setSpEntityId,
  acsUrl,
  setAcsUrl,
  canonicalAcs,
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
}: SamlProviderFieldsProps) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="IdP Entity ID"
          required
          value={idpEntityId}
          onChange={(event) => {
            setIdpEntityId(event);
            if (!issuer) setIssuer(event);
          }}
        />
        <Field
          label="IdP SSO URL"
          required
          value={entryPoint}
          onChange={setEntryPoint}
        />
        <Field
          label="SP Entity ID"
          required
          value={spEntityId}
          onChange={setSpEntityId}
        />
        <Field
          label="ACS URL"
          value={acsUrl || canonicalAcs}
          onChange={setAcsUrl}
          hint="Canonical callback: verify the configured public origin."
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={assertionsSigned}
            onChange={(event) => setAssertionsSigned(event.target.checked)}
          />
          Require signed assertions
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={responsesSigned}
            onChange={(event) => setResponsesSigned(event.target.checked)}
          />
          Require signed responses
        </label>
      </div>
      <div className="space-y-4">
        <TextArea
          label="Trusted IdP certificate PEM"
          required={!provider}
          value={certificate}
          onChange={setCertificate}
          hint={
            "PEM is submitted only to the certificate mutation. " +
            "Existing PEM is never returned."
          }
        />
        <TextArea
          label="Replacement trust set (optional)"
          value={trustedCertificates}
          onChange={setTrustedCertificates}
          hint="Separate certificates with a blank line; maximum two trusted certificates."
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={signRequests}
            onChange={(event) => setSignRequests(event.target.checked)}
          />
          Sign authentication requests (requires backend-managed key material)
        </label>
      </div>
    </>
  );
}
