"use client";

import { useQuery } from "@tanstack/react-query";

import { adminApi } from "../../../lib/api/admin";
import { adminQueryKeys } from "../../../lib/api/query-keys";
import { Notice, Panel, Table } from "../admin-ui";

export function AuditPanel() {
  const query = useQuery({ queryKey: adminQueryKeys.audit(100), queryFn: () => adminApi.listAudit(100), retry: false });
  return <Panel title="Audit history"><Notice error={query.error} />{query.isLoading ? <p>Loading audit history…</p> : <Table><thead><tr className="border-b border-[var(--color-border)]"><th className="p-3">Time</th><th className="p-3">Action</th><th className="p-3">Target</th><th className="p-3">Outcome</th></tr></thead><tbody>{(query.data?.events ?? []).map((event) => <tr key={event.event_id} className="border-b border-[var(--color-border)] last:border-0"><td className="p-3">{event.timestamp}</td><td className="p-3 font-mono text-xs">{event.action}</td><td className="p-3">{event.target_type}/{event.target_id}</td><td className="p-3">{event.outcome}</td></tr>)}</tbody></Table>}</Panel>;
}
