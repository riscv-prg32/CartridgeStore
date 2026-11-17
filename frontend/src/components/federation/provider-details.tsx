"use client";

import Link from "next/link";

import type { FederationProviderInput } from "../../lib/api/federation-admin";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { hasFederationPermission } from "./FederationAdminGuard";
import { Notice, Panel } from "./presentation";
import {
  ProviderEndpointPanel,
  ProviderHeader,
} from "./provider-details-panels";
import {
  ProviderSafeConfigurationPanel,
  ProviderSecretRotationPanel,
  ProviderTransactionsPanel,
} from "./provider-details-content";
import { ProviderForm } from "./provider-form";
import { useProviderDetails } from "./use-provider-details";
import { useSensitiveActions } from "./use-sensitive-actions";

/** Displays safe provider configuration and privileged federation actions. */
export function ProviderDetails({ providerId }: { providerId: string }) {
  const current = useCurrentUser();
  const manage = hasFederationPermission(current.user, "federation:manage");
  const actions = useSensitiveActions();
  const {
    providerQuery,
    statusQuery,
    provider,
    editing,
    setEditing,
    success,
    error,
    mutation,
    stateMutation,
    rotateMutation,
    certMutation,
    revokeMutation,
    secret,
    setSecret,
    certificates,
    setCertificates,
    publicOrigin,
    canonicalRedirect,
    canonicalAcs,
    sensitive,
  } = useProviderDetails(providerId, actions);

  if (providerQuery.isLoading || statusQuery.isLoading) {
    return <p role="status">Loading provider…</p>;
  }

  if (providerQuery.error || !provider) {
    return (
      <div className="space-y-3">
        <Notice error={providerQuery.error ?? statusQuery.error} />
        <Link
          className="text-sm font-semibold text-violet-700"
          href="/admin/federation/providers"
        >
          Back to providers
        </Link>
      </div>
    );
  }

  const updateProvider = (
    input:
      | FederationProviderInput
      | Omit<FederationProviderInput, "provider_id" | "protocol" | "issuer">,
  ) => {
    sensitive(
      () =>
        mutation.mutate(
          input as Omit<
            FederationProviderInput,
            "provider_id" | "protocol" | "issuer"
          >,
        ),
      () => setSecret(""),
    );
  };

  return (
    <div className="space-y-5">
      {actions.dialog}
      <ProviderHeader
        provider={provider}
        manage={manage}
        editing={editing}
        toggleEditing={() => setEditing((value) => !value)}
        toggleEnabled={() => {
          if (
            provider.enabled &&
            !window.confirm(
              "Disable this provider? New federated logins will stop.",
            )
          ) {
            return;
          }
          sensitive(() => stateMutation.mutate(!provider.enabled));
        }}
        statePending={stateMutation.isPending}
      />

      <Notice
        error={
          error ??
          providerQuery.error ??
          mutation.error ??
          stateMutation.error ??
          rotateMutation.error ??
          certMutation.error ??
          revokeMutation.error
        }
        success={success}
      />

      {editing && manage ? (
        <Panel title="Edit provider">
          <ProviderForm
            protocol={provider.protocol}
            provider={provider}
            onSubmit={updateProvider}
            pending={mutation.isPending}
            error={mutation.error}
            onCancel={() => setEditing(false)}
          />
        </Panel>
      ) : (
        <>
          <ProviderSafeConfigurationPanel
            provider={provider}
            certificates={certificates}
            setCertificates={setCertificates}
            manage={manage}
            mutation={certMutation}
            request={sensitive}
          />

          <ProviderEndpointPanel
            provider={provider}
            publicOrigin={publicOrigin}
            canonicalRedirect={canonicalRedirect}
            canonicalAcs={canonicalAcs}
          />

          {manage && provider.protocol === "oidc" && (
            <ProviderSecretRotationPanel
              secret={secret}
              setSecret={setSecret}
              mutation={rotateMutation}
              request={sensitive}
            />
          )}

          {manage && (
            <ProviderTransactionsPanel
              pendingTransactions={provider.pending_transactions}
              mutation={revokeMutation}
              request={sensitive}
            />
          )}
        </>
      )}
    </div>
  );
}
