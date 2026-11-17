"use client";

import { ArrowUpRight, Globe2, ShieldCheck } from "lucide-react";

import { authErrorMessage, federatedLoginUrl } from "../../../lib/api/auth";
import { cn } from "../../../lib/cn";
import { StatusMessage } from "../../ui/status";
import { useAuthProviders } from "./use-auth-providers";

type FederatedLoginOptionsProps = {
  enabled: boolean;
  returnTo: string;
};

export function FederatedLoginOptions({ enabled, returnTo }: FederatedLoginOptionsProps) {
  const providers = useAuthProviders(enabled);
  const enabledProviders = providers.data?.providers.filter((provider) => provider.enabled) ?? [];

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] p-6 sm:p-10 md:border-l md:border-t-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="technical-label text-[var(--color-primary)]">Federated access</p>
          <h2 className="mt-2 text-lg font-semibold">Continue with a provider</h2>
        </div>
        <span className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
          SSO
        </span>
      </div>
      <p className="mt-3 max-w-sm text-sm leading-6 text-[var(--color-text-muted)]">
        Use an institution or organization account configured for Cartridge Store.
      </p>
      {providers.isPending && <p className="mt-6 text-sm text-[var(--color-text-muted)]" role="status">Loading providers…</p>}
      {providers.error && <StatusMessage tone="warning" role="alert" className="mt-6">{authErrorMessage(providers.error, "providers")} Local sign-in remains available.</StatusMessage>}
      {!providers.isPending && !providers.error && enabledProviders.length === 0 && <p className="mt-6 text-sm text-[var(--color-text-muted)]">No federated providers are enabled.</p>}
      <div className="mt-7 space-y-3">
        {enabledProviders.map((provider) => (
          <a
            key={`${provider.protocol}:${provider.provider_id}`}
            href={federatedLoginUrl(provider, returnTo)}
            className={cn(
              "group flex min-h-16 items-center gap-3 rounded-lg border",
              "border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm",
              "transition-colors hover:border-[var(--color-primary)]",
              "hover:bg-[var(--color-primary-soft)] focus-visible:outline-2",
              "focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]",
            )}
          >
            {(() => {
              const ProtocolIcon = provider.protocol === "oidc" ? Globe2 : ShieldCheck;
              const protocolLabel = provider.protocol === "oidc" ? "OIDC" : "SAML 2.0";

              return (
                <>
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]">
                    <ProtocolIcon aria-hidden="true" className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-[var(--color-text)]">{provider.display_name}</span>
                    <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">Continue with {protocolLabel}</span>
                  </span>
                  <ArrowUpRight
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 text-[var(--color-text-muted)]",
                      "transition-transform group-hover:-translate-y-0.5",
                      "group-hover:translate-x-0.5",
                      "group-hover:text-[var(--color-primary-strong)]",
                    )}
                  />
                </>
              );
            })()}
          </a>
        ))}
      </div>
    </div>
  );
}
