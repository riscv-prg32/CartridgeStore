"use client";

import { useState } from "react";

import type { AdminGroup, AdminRole, AdminUser } from "../../../lib/api/admin";
import { Button } from "../../ui/button";
import { Field } from "../admin-ui";

export function UserDetails({ user, roles, groups, onUpdate, onRole, onGroups, onStatus, onDelete }: { user: AdminUser; roles: AdminRole[]; groups: AdminGroup[]; onUpdate: (input: Record<string, unknown>) => void; onRole: (role: string) => void; onGroups: (ids: number[]) => void; onStatus: (status: "active" | "suspended" | "banned") => void; onDelete: () => void }) {
  const [email, setEmail] = useState(user.email);
  const [selectedGroups, setSelectedGroups] = useState(user.groups.map((group) => group.id));
  return <div className="space-y-4 rounded-md border border-[var(--color-border)] p-4"><h3 className="font-semibold">Edit {user.username}</h3><p className="text-sm">Current status: <strong>{user.account_status}</strong>{user.status_reason ? ` · ${user.status_reason}` : ""}</p><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => onStatus("active")}>Activate</Button><Button variant="danger" onClick={() => onStatus("suspended")}>Suspend</Button><Button variant="danger" onClick={() => onStatus("banned")}>Ban</Button></div><Field label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /><Button variant="secondary" onClick={() => onUpdate({ email })}>Save email</Button><label className="grid gap-1 text-sm font-medium"><span>Role</span><select className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3" value={user.role} onChange={(event) => onRole(event.target.value)}>{roles.map((role) => <option key={role.name}>{role.name}</option>)}</select></label><fieldset className="space-y-2"><legend className="text-sm font-semibold">Groups</legend>{groups.map((group) => <label key={group.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedGroups.includes(group.id)} disabled={group.name === "editors"} onChange={(event) => setSelectedGroups((current) => event.target.checked ? [...current, group.id] : current.filter((id) => id !== group.id))} />{group.name}</label>)}<Button variant="secondary" onClick={() => onGroups(selectedGroups)}>Save groups</Button></fieldset><Button variant="danger" onClick={onDelete}>Delete user</Button></div>;
}
