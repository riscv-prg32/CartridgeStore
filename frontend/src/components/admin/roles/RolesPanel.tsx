"use client";

import { useQuery } from "@tanstack/react-query";

import { adminApi } from "../../../lib/api/admin";
import { adminQueryKeys } from "../../../lib/api/query-keys";
import { Notice, Panel, Table } from "../admin-ui";

export function RolesPanel() {
  const query = useQuery({ queryKey: adminQueryKeys.roles(), queryFn: adminApi.getRoles, retry: false });
  return <Panel title="Roles"><Notice error={query.error} />{query.isLoading ? <p>Loading roles…</p> : <Table><thead><tr className="border-b border-[var(--color-border)]"><th className="p-3">Role</th><th className="p-3">Level</th><th className="p-3">Users</th></tr></thead><tbody>{(query.data?.roles ?? []).map((role) => <tr key={role.name} className="border-b border-[var(--color-border)] last:border-0"><td className="p-3">{role.name}</td><td className="p-3">{role.level}</td><td className="p-3">{role.user_count}</td></tr>)}</tbody></Table>}</Panel>;
}
