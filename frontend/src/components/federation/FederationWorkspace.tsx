"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { useSensitiveActions } from "./use-sensitive-actions";
import { federationAdminApi, type FederationProviderInput } from "../../lib/api/federation-admin";
import { federationQueryKeys } from "../../lib/api/query-keys";
import { hasFederationPermission } from "./FederationAdminGuard";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import {
  Notice,
  Panel,
} from "./presentation";
import { ProviderForm } from "./provider-form";
export { ProviderList } from "./provider-list";
export { ProviderForm } from "./provider-form";
export { ProviderDetails } from "./provider-details";
export { IdentityLinks } from "./identity-links";

export function FederationOverview() {
  const query = useQuery({ queryKey: federationQueryKeys.providers(), queryFn: federationAdminApi.listProviders, retry: false });
  const providers = useMemo(() => query.data?.providers ?? [], [query.data]);
  const counts = useMemo(() => ({ enabled: providers.filter((item) => item.enabled).length, disabled: providers.filter((item) => !item.enabled).length, oidc: providers.filter((item) => item.protocol === "oidc").length, saml: providers.filter((item) => item.protocol === "saml").length, incomplete: providers.filter((item) => !item.configuration_complete).length }), [providers]);
  return <div className="space-y-5"><div><p className="text-sm font-semibold uppercase tracking-wide text-violet-700">Standards-based identity</p><h2 className="mt-1 text-3xl font-bold tracking-tight">Federation overview</h2><p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">Manage generic OIDC and SAML 2.0 provider metadata. Authentication, authorization, and protocol validation remain backend responsibilities.</p></div><Notice error={query.error} />{query.isLoading ? <p role="status">Loading federation status…</p> : <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[["Providers", providers.length], ["Enabled", counts.enabled], ["Disabled", counts.disabled], ["OIDC / SAML", `${counts.oidc} / ${counts.saml}`], ["Incomplete", counts.incomplete]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></div>)}</div><Panel title="Next steps"><div className="flex flex-wrap gap-3"><Link className="rounded-md bg-violet-700 px-4 py-2 text-sm font-semibold text-white" href="/admin/federation/providers">Review providers</Link><Link className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm font-semibold" href="/admin/federation/identities">Review identity links</Link></div></Panel></>}</div>;
}

export function NewProvider() {
  const router = useRouter(); const current = useCurrentUser(); const manage = hasFederationPermission(current.user, "federation:manage"); const [protocol, setProtocol] = useState<"oidc" | "saml" | null>(null); const [error, setError] = useState<unknown>(); const actions = useSensitiveActions(); const mutation = useMutation({ mutationFn: federationAdminApi.createProvider, onSuccess: (result) => router.replace(`/admin/federation/providers/${encodeURIComponent(result.provider.provider_id)}`) });
  if (!manage) return <Panel title="Read-only access"><p className="text-sm text-[var(--color-text-muted)]">You can inspect providers, but federation:manage is required to create one.</p></Panel>;
  if (!protocol) return <Panel title="Choose a provider protocol"><p className="mb-4 text-sm text-[var(--color-text-muted)]">PRG32 accepts generic standards-based providers. Choose the protocol supplied by your Identity Provider.</p><div className="grid gap-3 sm:grid-cols-2"><button className="rounded-lg border border-[var(--color-border)] p-4 text-left hover:bg-[var(--color-surface-muted)]" onClick={() => setProtocol("oidc")}><strong>OpenID Connect</strong><span className="mt-1 block text-sm text-[var(--color-text-muted)]">Issuer discovery and OAuth client credentials.</span></button><button className="rounded-lg border border-[var(--color-border)] p-4 text-left hover:bg-[var(--color-surface-muted)]" onClick={() => setProtocol("saml")}><strong>SAML 2.0</strong><span className="mt-1 block text-sm text-[var(--color-text-muted)]">Entity IDs, SSO endpoint, ACS, and trusted signing certificates.</span></button></div></Panel>;
  const submit = (input: FederationProviderInput | Omit<FederationProviderInput, "provider_id" | "protocol" | "issuer">) => { setError(undefined); actions.request(() => { void mutation.mutateAsync(input as FederationProviderInput).catch((value) => setError(value)); }, () => undefined); };
  return <div className="space-y-5">{actions.dialog}<div><Link className="text-sm font-semibold text-violet-700 hover:underline" href="/admin/federation/providers">← Providers</Link><h2 className="mt-2 text-3xl font-bold">New {protocol.toUpperCase()} provider</h2></div><Panel title="Provider configuration"><ProviderForm protocol={protocol} onSubmit={submit} pending={mutation.isPending} error={error ?? mutation.error} onCancel={() => router.push("/admin/federation/providers")} /></Panel></div>;
}
