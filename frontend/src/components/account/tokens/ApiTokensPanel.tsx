"use client";

import { useState } from "react";

import { Button } from "../../ui/button";
import { Field } from "../../ui/input";
import { StatusMessage } from "../../ui/status";
import { accountOperationError } from "../account-ui";
import { useApiTokens } from "./use-api-tokens";

function TokenRow({ id, label, lastUsed, disabled, onRename, onRevoke }: { id: number; label: string; lastUsed: string; disabled: boolean; onRename: (label: string) => void; onRevoke: () => void }) {
  const [nextLabel, setNextLabel] = useState(label);
  return <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between"><div className="min-w-0 flex-1"><Field label="Label" value={nextLabel} maxLength={80} onChange={(event) => setNextLabel(event.target.value)} /><p className="mt-1 text-xs text-[var(--color-text-muted)]">Last used: {lastUsed || "Never"} · ID {id}</p></div><div className="flex gap-2"><Button size="sm" type="button" variant="secondary" disabled={disabled || !nextLabel.trim() || nextLabel === label} onClick={() => onRename(nextLabel.trim())}>Rename</Button><Button size="sm" type="button" variant="danger" disabled={disabled} onClick={onRevoke}>Revoke</Button></div></li>;
}

export function ApiTokensPanel() {
  const [label, setLabel] = useState("");
  const { tokens, create, revoke, rename, newToken, dismissNewToken } = useApiTokens();
  return <section className="surface-card p-5 sm:p-6" aria-labelledby="tokens-heading"><div className="flex flex-col gap-1 border-b border-[var(--color-border)] pb-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 id="tokens-heading" className="text-lg font-bold">API tokens</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">For firmware and automation clients. Secrets are shown once.</p></div><span className="technical-label text-[var(--color-text-muted)]">Developer access</span></div>{newToken && <StatusMessage tone="warning" className="mt-4 p-4"><strong>New token:</strong> <code className="ml-1 break-all">{newToken}</code><button className="ml-3 font-semibold underline" type="button" onClick={dismissNewToken}>Dismiss</button></StatusMessage>}<form className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); if (label.trim()) create.mutate(label.trim(), { onSuccess: () => setLabel("") }); }}><Field className="flex-1" label="Token label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Firmware client" maxLength={80} /><Button type="submit" loading={create.isPending} disabled={!label.trim()}>Create token</Button></form>{(create.error || revoke.error || rename.error || tokens.error) && <StatusMessage tone="danger" className="mt-4 border-0 bg-transparent px-0 py-0">{accountOperationError(create.error ?? revoke.error ?? rename.error ?? tokens.error)}</StatusMessage>}{tokens.isPending && <p className="mt-5 rounded-md bg-[var(--color-surface-muted)] p-4 text-sm" role="status">Loading token metadata…</p>}{tokens.data?.tokens.length === 0 && <p className="mt-5 rounded-md bg-[var(--color-surface-muted)] p-4 text-sm text-[var(--color-text-muted)]">No API tokens have been created.</p>}{tokens.data && tokens.data.tokens.length > 0 && <ul className="mt-5 divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">{tokens.data.tokens.map((token) => <TokenRow key={token.id} id={token.id} label={token.label} lastUsed={token.last_used} disabled={revoke.isPending || rename.isPending} onRename={(nextLabel) => rename.mutate({ id: token.id, nextLabel })} onRevoke={() => { if (window.confirm(`Revoke ${token.label}?`)) revoke.mutate(token.id); }} />)}</ul>}</section>;
}
