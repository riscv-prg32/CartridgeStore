"use client";

import type { FormEvent } from "react";
import type { Dispatch, SetStateAction } from "react";

import type {
  FederationProvider,
} from "../../lib/api/federation-admin";
import { Button } from "../ui/button";
import { Field, Panel } from "./presentation";
import type { IdentityLinkFormState } from "./identity-link-types";

type IdentityLinksFormProps = {
  form: IdentityLinkFormState;
  providers: readonly FederationProvider[] | undefined;
  selectedProvider: FederationProvider | undefined;
  setForm: Dispatch<SetStateAction<IdentityLinkFormState>>;
  pending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

/** Presents the explicit identity-link creation form. */
export function IdentityLinksForm({
  form,
  providers,
  selectedProvider,
  setForm,
  pending,
  onSubmit,
}: IdentityLinksFormProps) {
  return (
    <Panel title="Create explicit identity link">
      <form className="grid gap-4 md:grid-cols-2" onSubmit={onSubmit}>
        <label className="grid gap-1 text-sm font-medium">
          <span>Protocol *</span>
          <select
            required
            value={form.protocol}
            onChange={(event) =>
              setForm({
                ...form,
                protocol: event.target.value as "oidc" | "saml",
                provider_id: "",
              })
            }
            className={
              "min-h-10 rounded-md border border-[var(--color-border)] " +
              "bg-[var(--color-surface)] px-3"
            }
          >
            <option value="oidc">OIDC</option>
            <option value="saml">SAML 2.0</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          <span>Provider *</span>
          <select
            required
            value={form.provider_id}
            onChange={(event) => {
              const value = event.target.value;
              const provider = providers?.find(
                (item) => item.provider_id === value,
              );
              setForm({
                ...form,
                provider_id: value,
                issuer: provider?.issuer ?? "",
              });
            }}
            className={
              "min-h-10 rounded-md border border-[var(--color-border)] " +
              "bg-[var(--color-surface)] px-3"
            }
          >
            <option value="">Select a provider</option>
            {providers
              ?.filter((provider) => provider.protocol === form.protocol)
              .map((provider) => (
                <option
                  key={provider.provider_id}
                  value={provider.provider_id}
                >
                  {provider.display_name} ({provider.provider_id})
                </option>
              ))}
          </select>
        </label>
        <Field
          label="Issuer"
          required
          value={form.issuer}
          onChange={(event) =>
            setForm({ ...form, issuer: event.target.value })
          }
          hint="Must exactly match the provider issuer."
        />
        <Field
          label="External subject"
          required
          value={form.subject}
          onChange={(event) =>
            setForm({ ...form, subject: event.target.value })
          }
        />
        <Field
          label="Existing local user ID"
          required
          type="number"
          min="1"
          value={form.user_id}
          onChange={(event) =>
            setForm({ ...form, user_id: event.target.value })
          }
          hint={
            "Use an existing enabled local account; no lookup or " +
            "automatic creation is performed."
          }
        />
        <div className="flex items-end">
          <Button disabled={!selectedProvider || pending}>
            {pending ? "Linking…" : "Create identity link"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
