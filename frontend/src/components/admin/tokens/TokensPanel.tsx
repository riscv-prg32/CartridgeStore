"use client";

import type { AdminToken } from "../../../lib/api/admin";
import { Button } from "../../ui/button";
import { Notice, Panel, Table } from "../admin-ui";
import { useAdminTokens } from "./use-tokens";

function TokenRow({ token, onRevoke }: { token: AdminToken; onRevoke: () => void }) {
  return <tr className="border-b border-[var(--color-border)] last:border-0"><td className="p-3">{token.username}</td><td className="p-3">{token.label}</td><td className="p-3">{token.last_used || "Never"}</td><td className="p-3"><Button variant="danger" onClick={onRevoke}>Revoke</Button></td></tr>;
}

export function TokensPanel() {
  const { query, revoke } = useAdminTokens();
  return <Panel title="API tokens"><Notice error={query.error ?? revoke.error} /><p className="text-sm text-[var(--color-text-muted)]">Only token metadata is returned. Token secrets are never displayed here.</p>{query.isLoading ? <p>Loading tokens…</p> : <Table><thead><tr className="border-b border-[var(--color-border)]"><th className="p-3">Owner</th><th className="p-3">Label</th><th className="p-3">Last used</th><th className="p-3">Actions</th></tr></thead><tbody>{(query.data?.tokens ?? []).map((token) => <TokenRow key={token.id} token={token} onRevoke={() => { if (window.confirm("Revoke this token?")) revoke.mutate(token.id); }} />)}</tbody></Table>}</Panel>;
}
