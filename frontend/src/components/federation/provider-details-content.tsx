"use client";

import type { FederationProvider } from "../../lib/api/federation-admin";
import { Button } from "../ui/button";
import { CertificatePanel, Panel } from "./presentation";

type CertificateMutation = {
  isPending: boolean;
  mutate: (certificates: string[]) => void;
};

type SecretMutation = {
  isPending: boolean;
  mutate: (secret: string) => void;
};

type RevokeMutation = {
  isPending: boolean;
  mutate: () => void;
};

/** Presents safe provider settings and the optional certificate editor. */
export function ProviderSafeConfigurationPanel({
  provider,
  certificates,
  setCertificates,
  manage,
  mutation,
  request,
}: {
  provider: FederationProvider;
  certificates: string;
  setCertificates: (value: string) => void;
  manage: boolean;
  mutation: CertificateMutation;
  request: (action: () => void, clear?: () => void) => void;
}) {
  return (
    <Panel title="Safe configuration">
      <dl className="grid gap-4 sm:grid-cols-2">
        {[
          ["Issuer / entity", provider.issuer],
          ["Client ID", provider.client_id ?? "Not configured"],
          [
            "Configuration",
            provider.configuration_complete ? "Complete" : "Incomplete",
          ],
          ["Generation", provider.generation],
          ["Updated", provider.updated_at],
          ["Pending transactions", provider.pending_transactions],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt
              className={
                "text-xs font-semibold uppercase tracking-wide " +
                "text-[var(--color-text-muted)]"
              }
            >
              {label}
            </dt>
            <dd className="mt-1 break-all text-sm">{String(value)}</dd>
          </div>
        ))}
      </dl>
      {provider.protocol === "oidc" && (
        <div
          className={
            "mt-5 space-y-2 rounded-md bg-[var(--color-surface-muted)] " +
            "p-4 text-sm"
          }
        >
          <p>
            <strong>Redirect URI:</strong>{" "}
            <code className="break-all">
              {provider.redirect_uri ?? "Not configured"}
            </code>
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            Client secret configured: {" "}
            {provider.client_secret_configured
              ? "yes (value hidden)"
              : "no"}. Never use a masked value as a secret.
          </p>
        </div>
      )}
      {provider.protocol === "saml" && (
        <CertificatePanel
          provider={provider}
          certificates={certificates}
          setCertificates={setCertificates}
          manage={manage}
          mutation={mutation}
          request={request}
        />
      )}
    </Panel>
  );
}

/** Presents the privileged OIDC client-secret rotation control. */
export function ProviderSecretRotationPanel({
  secret,
  setSecret,
  mutation,
  request,
}: {
  secret: string;
  setSecret: (value: string) => void;
  mutation: SecretMutation;
  request: (action: () => void, clear?: () => void) => void;
}) {
  return (
    <Panel title="Rotate OIDC client secret">
      <p className="text-sm text-[var(--color-text-muted)]">
        Rotation replaces the existing secret, which is never readable here,
        and may invalidate pending authentication transactions.
      </p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <input
          aria-label="New OIDC client secret"
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          className={
            "min-h-10 flex-1 rounded-md border " +
            "border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          }
        />
        <Button
          disabled={!secret || mutation.isPending}
          onClick={() => {
            if (!window.confirm("Rotate this client secret?")) return;
            request(() => mutation.mutate(secret), () => setSecret(""));
          }}
        >
          {mutation.isPending ? "Rotating…" : "Rotate secret"}
        </Button>
      </div>
    </Panel>
  );
}

/** Presents the privileged pending-transaction revocation control. */
export function ProviderTransactionsPanel({
  pendingTransactions,
  mutation,
  request,
}: {
  pendingTransactions: number;
  mutation: RevokeMutation;
  request: (action: () => void, clear?: () => void) => void;
}) {
  return (
    <Panel title="Pending authentication transactions">
      <p className="text-sm text-[var(--color-text-muted)]">
        Current pending count: {pendingTransactions}. Revocation invalidates
        pending transactions for this provider.
      </p>
      <Button
        className="mt-3"
        variant="danger"
        disabled={!pendingTransactions || mutation.isPending}
        onClick={() => {
          if (
            window.confirm(
              "Revoke all pending transactions for this provider?",
            )
          ) {
            request(() => mutation.mutate());
          }
        }}
      >
        {mutation.isPending ? "Revoking…" : "Revoke pending transactions"}
      </Button>
    </Panel>
  );
}
