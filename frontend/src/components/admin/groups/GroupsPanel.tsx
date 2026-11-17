"use client";

import { useState } from "react";

import type { AdminGroup } from "../../../lib/api/admin";
import { Button } from "../../ui/button";
import { Field, Notice, Panel, Table } from "../admin-ui";
import { useAdminGroups } from "./use-groups";

function GroupRow({ group, onRename, onDelete }: { group: AdminGroup; onRename: (name: string) => void; onDelete: () => void }) {
  const [name, setName] = useState(group.name);
  const protectedGroup = group.name === "editors";
  return <tr className="border-b border-[var(--color-border)] last:border-0"><td className="p-3"><input className="w-full rounded border border-[var(--color-border)] bg-transparent px-2 py-1" value={name} disabled={protectedGroup} onChange={(event) => setName(event.target.value)} /></td><td className="p-3">{group.user_count}</td><td className="flex gap-2 p-3"><Button variant="secondary" disabled={protectedGroup} onClick={() => onRename(name)}>Rename</Button><Button variant="danger" disabled={protectedGroup} onClick={onDelete}>Delete</Button></td></tr>;
}

export function GroupsPanel() {
  const [name, setName] = useState("");
  const { groups, create, rename, remove } = useAdminGroups();
  return <Panel title="Groups"><Notice error={groups.error ?? create.error ?? rename.error ?? remove.error} success={create.isSuccess ? "Group created." : ""} /><Table><thead><tr className="border-b border-[var(--color-border)]"><th className="p-3">Name</th><th className="p-3">Users</th><th className="p-3">Actions</th></tr></thead><tbody>{(groups.data?.groups ?? []).map((group) => <GroupRow key={group.id} group={group} onRename={(value) => rename.mutate({ id: group.id, name: value })} onDelete={() => { if (window.confirm(`Delete ${group.name}?`)) remove.mutate(group.id); }} />)}</tbody></Table><form className="flex flex-wrap gap-3" onSubmit={(event) => { event.preventDefault(); create.mutate(name, { onSuccess: () => setName("") }); }}><Field label="New group" value={name} onChange={(event) => setName(event.target.value)} required /><Button disabled={!name || create.isPending}>Create group</Button></form></Panel>;
}
