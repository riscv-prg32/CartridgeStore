"use client";

import { useState } from "react";

import { Button } from "../../ui/button";
import { Field, Notice, Panel, Table } from "../admin-ui";
import { UserDetails } from "./UserDetails";
import { useAdminUsers } from "./use-users";

export function UsersPanel() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { users, roles, groups, selected, create, update, remove, role, groupsMutation, status } = useAdminUsers(search, page, selectedId);
  const totalPages = Math.max(1, Math.ceil((users.data?.total ?? 0) / Math.max(1, users.data?.limit ?? 25)));
  const error = users.error ?? selected.error ?? create.error ?? update.error ?? remove.error ?? role.error ?? groupsMutation.error ?? status.error;
  return <Panel title="Users"><Notice error={error} success={create.isSuccess ? "User created." : ""} /><div className="grid gap-5 xl:grid-cols-[1.3fr_1fr]"><div className="space-y-4"><Field label="Search users" value={search} placeholder="Username or email" onChange={(event) => { setSearch(event.target.value); setPage(1); }} /><div className="overflow-x-auto"><Table><thead><tr className="border-b border-[var(--color-border)]"><th className="p-3">Username</th><th className="p-3">Email</th><th className="p-3">Role</th><th className="p-3">Status</th></tr></thead><tbody>{users.isLoading ? <tr><td className="p-3" colSpan={4}>Loading users…</td></tr> : (users.data?.users ?? []).length === 0 ? <tr><td className="p-3" colSpan={4}>No users match this search.</td></tr> : (users.data?.users ?? []).map((user) => <tr key={user.id} className="cursor-pointer border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-surface-muted)]" onClick={() => setSelectedId(user.id)}><td className="p-3 font-medium">{user.username}</td><td className="p-3">{user.email}</td><td className="p-3">{user.role}</td><td className="p-3">{user.account_status}</td></tr>)}</tbody></Table></div><div className="flex items-center justify-between text-sm"><Button variant="secondary" disabled={page <= 1 || users.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button><span>Page {page} of {totalPages}</span><Button variant="secondary" disabled={page >= totalPages || users.isFetching} onClick={() => setPage((current) => current + 1)}>Next</Button></div><form className="grid gap-3 rounded-md border border-[var(--color-border)] p-4" onSubmit={(event) => { event.preventDefault(); create.mutate({ username, email, password }, { onSuccess: () => { setUsername(""); setEmail(""); setPassword(""); } }); }}><h3 className="font-semibold">Create user</h3><Field label="Username" value={username} required onChange={(event) => setUsername(event.target.value)} /><Field label="Email" type="email" value={email} required onChange={(event) => setEmail(event.target.value)} /><Field label="Password" type="password" value={password} required onChange={(event) => setPassword(event.target.value)} /><Button disabled={create.isPending}>{create.isPending ? "Creating…" : "Create user"}</Button></form></div><div className="space-y-4">{selectedId === null ? <p className="text-sm text-[var(--color-text-muted)]">Select a user to manage role, groups, or account data.</p> : selected.data?.user ? <UserDetails user={selected.data.user} roles={roles.data?.roles ?? []} groups={groups.data?.groups ?? []} onUpdate={(input) => update.mutate(input)} onRole={(value) => role.mutate(value)} onGroups={(ids) => groupsMutation.mutate(ids)} onStatus={(value) => status.mutate(value)} onDelete={() => { if (window.confirm("Delete this user?")) remove.mutate(undefined, { onSuccess: () => setSelectedId(null) }); }} /> : <p>Loading user…</p>}</div></div></Panel>;
}
