"use client";

import { Button } from "../../ui/button";
import { StatusMessage } from "../../ui/status";
import { usePasskeys } from "./use-passkeys";

function enrollmentError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Passkey enrollment was cancelled.";
  return "Passkey enrollment could not be completed. Check the password and try again.";
}

export function PasskeysPanel() {
  const { passkeys, enroll, rename, remove } = usePasskeys();
  const error = enroll.error ?? rename.error ?? remove.error;
  async function enrollPasskey() {
    const password = window.prompt("Enter your current password to authorize passkey enrollment.");
    if (password === null) return;
    const displayName = window.prompt("Name this passkey (for example: MacBook Touch ID).", "Passkey") ?? "Passkey";
    enroll.mutate({ password, displayName });
  }
  return <section className="surface-card p-5 sm:p-6" aria-labelledby="passkeys-heading"><div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 id="passkeys-heading" className="text-lg font-bold">Passkeys</h2><p className="mt-1 max-w-xl text-sm text-[var(--color-text-muted)]">Optional phishing-resistant sign-in. Password and generic OIDC/SAML recovery remain available.</p></div><Button size="sm" type="button" onClick={() => void enrollPasskey()} disabled={enroll.isPending}>{enroll.isPending ? "Waiting for authenticator…" : "Add passkey"}</Button></div>{error && <StatusMessage tone="danger" className="mt-4 border-0 bg-transparent px-0 py-0">{enrollmentError(error)}</StatusMessage>}{passkeys.error && <p className="mt-4 text-sm text-[var(--color-text-muted)]">Passkey management is not enabled in this deployment.</p>}{passkeys.isPending && <p className="mt-5 rounded-md bg-[var(--color-surface-muted)] p-4 text-sm" role="status">Loading passkeys…</p>}{passkeys.data?.credentials.length === 0 && <p className="mt-5 rounded-md bg-[var(--color-surface-muted)] p-4 text-sm text-[var(--color-text-muted)]">No passkeys are registered.</p>}{passkeys.data && passkeys.data.credentials.length > 0 && <ul className="mt-5 divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">{passkeys.data.credentials.map((credential) => <li key={credential.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{credential.display_name}</p><p className="text-xs text-[var(--color-text-muted)]">Added {credential.created_at}{credential.last_used_at ? ` · Last used ${credential.last_used_at}` : " · Never used"}{credential.revoked ? " · Revoked" : ""}</p></div><div className="flex gap-2"><Button type="button" variant="secondary" disabled={credential.revoked || rename.isPending} onClick={() => { const password = window.prompt("Enter your current password to authorize passkey management."); if (password === null) return; const name = window.prompt("New passkey name", credential.display_name); if (name?.trim()) rename.mutate({ id: credential.id, displayName: name.trim(), password }); }}>Rename</Button><Button type="button" variant="danger" disabled={credential.revoked || remove.isPending} onClick={() => { if (window.confirm(`Remove ${credential.display_name}?`)) { const password = window.prompt("Enter your current password to authorize passkey management."); if (password !== null) remove.mutate({ id: credential.id, password }); } }}>Remove</Button></div></li>)}</ul>}</section>;
}
