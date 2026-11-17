"use client";

import { useCurrentUser } from "../../lib/auth/use-current-user";
import { hasFederationPermission } from "./FederationAdminGuard";
import { Notice } from "./presentation";
import { IdentityLinksForm } from "./identity-links-form";
import { IdentityLinksTable } from "./identity-links-table";
import { useIdentityLinks } from "./use-identity-links";
import { useSensitiveActions } from "./use-sensitive-actions";

/** Manages explicit mappings between external identities and local users. */
export function IdentityLinks() {
  const current = useCurrentUser();
  const manage = hasFederationPermission(current.user, "federation:manage");
  const actions = useSensitiveActions();
  const {
    query,
    providers,
    form,
    setForm,
    success,
    link,
    retire,
    selectedProvider,
  } = useIdentityLinks();

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProvider) return;
    actions.request(() => link.mutate(), undefined);
  };

  return (
    <div className="space-y-5">
      {actions.dialog}
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-violet-700">
          Explicit mapping
        </p>
        <h2 className="mt-1 text-3xl font-bold">Identity links</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Links are keyed by protocol, provider, issuer, and external subject.
          Users are never created or matched by email.
        </p>
      </div>
      <Notice
        error={query.error ?? providers.error ?? link.error ?? retire.error}
        success={success}
      />
      {query.isLoading ? (
        <p role="status">Loading identity links…</p>
      ) : (
        <IdentityLinksTable
          identities={query.data?.identities}
          manage={manage}
          onRetire={(id) => actions.request(() => retire.mutate(id))}
        />
      )}
      {manage && (
        <IdentityLinksForm
          form={form}
          providers={providers.data?.providers}
          selectedProvider={selectedProvider}
          setForm={setForm}
          pending={link.isPending}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
