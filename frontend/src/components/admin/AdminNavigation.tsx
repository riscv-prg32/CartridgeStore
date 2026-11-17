"use client";

import type { AdminSection } from "../../stores/admin-store";

export type AdminNavigationItem = { section: AdminSection; label: string; permission: string };

export const ADMIN_NAV_ITEMS: AdminNavigationItem[] = [
  { section: "settings", label: "Settings", permission: "settings:read" },
  { section: "users", label: "Users", permission: "users:read" },
  { section: "groups", label: "Groups", permission: "groups:read" },
  { section: "roles", label: "Roles", permission: "roles:read" },
  { section: "tokens", label: "Tokens", permission: "tokens:read:any" },
  { section: "catalog", label: "Catalog", permission: "catalog:metadata:write" },
  { section: "audit", label: "Audit", permission: "settings:read" },
  { section: "backup", label: "Backup", permission: "backup:export" },
];

export function AdminNavigation({ items, selected, onSelect }: { items: AdminNavigationItem[]; selected: AdminSection; onSelect: (section: AdminSection) => void }) {
  return <nav aria-label="Administrative sections" className="flex min-w-0 max-w-full flex-wrap gap-2 lg:flex-col">{items.map((item) => <button key={item.section} type="button" className={`rounded-lg px-3 py-2 text-left text-sm font-semibold ${selected === item.section ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]"}`} onClick={() => onSelect(item.section)}>{item.label}</button>)}</nav>;
}
