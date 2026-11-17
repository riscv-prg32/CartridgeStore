"use client";

import type { ChangeEventHandler } from "react";

import type { FederationProvider } from "../../lib/api/federation-admin";
import { Field } from "./presentation";

/** Controlled values and setters for OIDC provider fields. */
export interface OidcProviderFieldsProps {
  readonly provider?: FederationProvider;
  readonly clientId: string;
  readonly setClientId: ChangeEventHandler<HTMLInputElement>;
  readonly clientAuthMethod: FederationProvider["client_auth_method"];
  readonly setClientAuthMethod: (
    value: FederationProvider["client_auth_method"],
  ) => void;
  readonly clientSecret: string;
  readonly setClientSecret: ChangeEventHandler<HTMLInputElement>;
  readonly discoveryIssuer: string;
  readonly setDiscoveryIssuer: ChangeEventHandler<HTMLInputElement>;
  readonly redirectUri: string;
  readonly setRedirectUri: ChangeEventHandler<HTMLInputElement>;
  readonly canonicalRedirect: string;
  readonly scopes: string;
  readonly setScopes: ChangeEventHandler<HTMLInputElement>;
}

/** Renders the controlled OIDC-specific provider fields. */
export function OidcProviderFields({
  provider,
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
  canonicalRedirect,
  scopes,
  setScopes,
}: OidcProviderFieldsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field
        label="Client ID"
        value={clientId}
        onChange={setClientId}
      />
      <label className="grid gap-1 text-sm font-medium">
        <span>Client authentication method</span>
        <select
          value={clientAuthMethod}
          onChange={(event) =>
            setClientAuthMethod(
              event.target.value as FederationProvider["client_auth_method"],
            )
          }
          className={
            "min-h-10 rounded-md border border-[var(--color-border)] " +
            "bg-[var(--color-surface)] px-3"
          }
        >
          <option value="client_secret_basic">client_secret_basic</option>
          <option value="client_secret_post">client_secret_post</option>
          <option value="none">none</option>
        </select>
      </label>
      <Field
        label={provider ? "New client secret (optional)" : "Client secret"}
        type="password"
        value={clientSecret}
        onChange={setClientSecret}
        autoComplete="new-password"
        hint="Never displayed again; use rotation later to replace it."
      />
      <Field
        label="Discovery issuer (optional)"
        value={discoveryIssuer}
        onChange={setDiscoveryIssuer}
      />
      <Field
        label="Redirect URI"
        value={redirectUri || canonicalRedirect}
        onChange={setRedirectUri}
        hint="Verify this against the backend public origin before saving."
      />
      <Field
        label="Scopes"
        value={scopes}
        onChange={setScopes}
        hint="Comma-separated; include openid for usable OIDC login."
      />
    </div>
  );
}
