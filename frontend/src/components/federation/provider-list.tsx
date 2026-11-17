"use client";

import Link from "next/link";

import type { FederationProvider } from "../../lib/api/federation-admin";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { useFederationStore } from "../../stores/federation-store";
import { Button } from "../ui/button";
import { hasFederationPermission } from "./FederationAdminGuard";
import { Notice, Panel, StatusBadge } from "./presentation";
import { useSensitiveActions } from "./use-sensitive-actions";
import { useProviderList } from "./use-provider-list";

/** Lists configured federation providers and exposes their state toggle. */
export function ProviderList() {
  const current = useCurrentUser();
  const manage = hasFederationPermission(current.user, "federation:manage");
  const setSelectedProviderId = useFederationStore(
    (state) => state.setSelectedProviderId,
  );
  const actions = useSensitiveActions();
  const { query, mutation, success, setSuccess } = useProviderList();

  const changeState = (provider: FederationProvider) => {
    if (
      !provider.enabled &&
      !window.confirm(`Enable ${provider.display_name}?`)
    ) {
      return;
    }
    if (
      provider.enabled &&
      !window.confirm(
        `Disable ${provider.display_name}? New federated logins will stop.`,
      )
    ) {
      return;
    }
    setSuccess("");
    actions.request(() =>
      mutation.mutate({
        id: provider.provider_id,
        enabled: !provider.enabled,
      }),
    );
  };

  return (
    <div className="space-y-5">
      {actions.dialog}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-violet-700">
            Provider registry
          </p>
          <h2 className="mt-1 text-3xl font-bold">Providers</h2>
        </div>
        {manage && (
          <Link
            className="rounded-md bg-violet-700 px-4 py-2 text-sm font-semibold text-white"
            href="/admin/federation/providers/new"
          >
            Add provider
          </Link>
        )}
      </div>
      <Notice error={query.error ?? mutation.error} success={success} />
      {query.isLoading ? (
        <p role="status">Loading providers…</p>
      ) : query.data?.providers.length === 0 ? (
        <Panel title="No providers configured">
          <p className="text-sm text-[var(--color-text-muted)]">
            Create a generic OIDC or SAML provider to make it available for
            later interoperability testing.
          </p>
        </Panel>
      ) : (
        <div className="grid gap-3">
          {query.data?.providers.map((provider) => (
            <article
              key={provider.provider_id}
              className={
                "rounded-lg border border-[var(--color-border)] " +
                "bg-[var(--color-surface)] p-4"
              }
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{provider.display_name}</h3>
                    <span
                      className={
                        "rounded-full bg-[var(--color-surface-muted)] px-2 " +
                        "py-1 text-xs font-semibold uppercase"
                      }
                    >
                      {provider.protocol}
                    </span>
                    <StatusBadge enabled={provider.enabled} />
                  </div>
                  <p className="mt-1 font-mono text-xs text-[var(--color-text-muted)]">
                    {provider.provider_id}
                  </p>
                  <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                    {provider.protocol === "oidc"
                      ? provider.issuer
                      : provider.idp_entity_id ?? provider.issuer}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link
                    className={
                      "rounded-md border border-[var(--color-border)] " +
                      "px-3 py-2 text-sm font-semibold"
                    }
                    href={`/admin/federation/providers/${encodeURIComponent(provider.provider_id)}`}
                    onClick={() =>
                      setSelectedProviderId(provider.provider_id)
                    }
                  >
                    Details
                  </Link>
                  {manage && (
                    <Button
                      variant="secondary"
                      className="min-h-9 px-3 py-1 text-xs"
                      onClick={() => changeState(provider)}
                      disabled={mutation.isPending}
                    >
                      {provider.enabled ? "Disable" : "Enable"}
                    </Button>
                  )}
                </div>
              </div>
              <div
                className={
                  "mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs " +
                  "text-[var(--color-text-muted)]"
                }
              >
                <span>
                  Configuration: {" "}
                  <strong className="text-[var(--color-text)]">
                    {provider.configuration_complete ? "complete" : "incomplete"}
                  </strong>
                </span>
                <span>
                  Generation: {" "}
                  <strong className="text-[var(--color-text)]">
                    {provider.generation}
                  </strong>
                </span>
                <span>
                  Pending transactions: {" "}
                  <strong className="text-[var(--color-text)]">
                    {provider.pending_transactions}
                  </strong>
                </span>
                {provider.protocol === "saml" && (
                  <span>
                    Certificates: {" "}
                    <strong className="text-[var(--color-text)]">
                      {provider.trusted_certificate_count}/
                      {provider.trusted_certificate_capacity}
                    </strong>
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
