"use client";

import Link from "next/link";

import type { FederationProvider } from "../../lib/api/federation-admin";
import { publicApiPath } from "../../lib/api/origin";
import { Button } from "../ui/button";
import {
  Endpoint,
  Panel,
  StatusBadge,
} from "./presentation";

/** Properties for the provider identity and privileged action header. */
export interface ProviderHeaderProps {
  readonly provider: FederationProvider;
  readonly manage: boolean;
  readonly editing: boolean;
  readonly toggleEditing: () => void;
  readonly toggleEnabled: () => void;
  readonly statePending: boolean;
}

/** Renders the provider title, navigation and state actions. */
export function ProviderHeader({
  provider,
  manage,
  editing,
  toggleEditing,
  toggleEnabled,
  statePending,
}: ProviderHeaderProps) {
  return (
    <div>
      <Link
        className="text-sm font-semibold text-violet-700 hover:underline"
        href="/admin/federation/providers"
      >
        ← Providers
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-3xl font-bold">{provider.display_name}</h2>
            <StatusBadge enabled={provider.enabled} />
          </div>
          <p className="mt-1 font-mono text-xs text-[var(--color-text-muted)]">
            {provider.provider_id} · {provider.protocol.toUpperCase()}
          </p>
        </div>
        <div className="flex gap-2">
          {manage && (
            <Button variant="secondary" onClick={toggleEditing}>
              {editing ? "Close edit" : "Edit"}
            </Button>
          )}
          {manage && (
            <Button
              variant={provider.enabled ? "danger" : "primary"}
              onClick={toggleEnabled}
              disabled={statePending}
            >
              {provider.enabled ? "Disable" : "Enable"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Properties for canonical federation callback endpoint presentation. */
export interface ProviderEndpointPanelProps {
  readonly provider: FederationProvider;
  readonly publicOrigin: string;
  readonly canonicalRedirect: string;
  readonly canonicalAcs: string;
}

/** Displays the canonical OIDC and SAML endpoints for a provider. */
export function ProviderEndpointPanel({
  provider,
  publicOrigin,
  canonicalRedirect,
  canonicalAcs,
}: ProviderEndpointPanelProps) {
  return (
    <Panel title="Canonical endpoints">
      <Endpoint
        label="OIDC callback"
        value={
          provider.protocol === "oidc"
            ? provider.redirect_uri ?? canonicalRedirect
            : "Not applicable"
        }
      />
      <Endpoint
        label="SAML ACS"
        value={
          provider.protocol === "saml"
            ? provider.acs_url ?? canonicalAcs
            : "Not applicable"
        }
      />
      <Endpoint
        label="SAML metadata"
        value={
          provider.protocol === "saml"
            ? `${publicOrigin}/api/auth/saml/${encodeURIComponent(
                provider.provider_id,
              )}/metadata`
            : "Not applicable"
        }
        link={
          provider.protocol === "saml"
            ? publicApiPath(
                `/api/auth/saml/${encodeURIComponent(
                  provider.provider_id,
                )}/metadata`,
              )
            : undefined
        }
      />
    </Panel>
  );
}
