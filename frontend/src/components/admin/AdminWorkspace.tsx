"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { adminApi } from "../../lib/api/admin";
import { adminQueryKeys } from "../../lib/api/query-keys";
import { useAdminStore, type AdminSection } from "../../stores/admin-store";
import { AdminNavigation, ADMIN_NAV_ITEMS } from "./AdminNavigation";
import { Notice } from "./admin-ui";
import { AuditPanel } from "./audit/AuditPanel";
import { BackupPanel } from "./backups/BackupPanel";
import { CatalogModerationPanel } from "./catalog/CatalogModerationPanel";
import { GroupsPanel } from "./groups/GroupsPanel";
import { RolesPanel } from "./roles/RolesPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { TokensPanel } from "./tokens/TokensPanel";
import { UsersPanel } from "./users/UsersPanel";

function ActivePanel({ section }: { section: AdminSection }) {
  if (section === "settings") return <SettingsPanel />;
  if (section === "users") return <UsersPanel />;
  if (section === "groups") return <GroupsPanel />;
  if (section === "roles") return <RolesPanel />;
  if (section === "tokens") return <TokensPanel />;
  if (section === "catalog") return <CatalogModerationPanel />;
  if (section === "audit") return <AuditPanel />;
  return <BackupPanel />;
}

export function AdminWorkspace() {
  const section = useAdminStore((state) => state.section);
  const setSection = useAdminStore((state) => state.setSection);
  const principal = useQuery({ queryKey: adminQueryKeys.principal(), queryFn: adminApi.getPrincipal, retry: false });
  const permissions = useMemo(() => new Set(principal.data?.user.permissions ?? []), [principal.data]);
  const available = ADMIN_NAV_ITEMS.filter((item) => permissions.has(item.permission));
  useEffect(() => { const first = available[0]; if (first && !available.some((item) => item.section === section)) setSection(first.section); }, [available, section, setSection]);
  if (principal.isLoading) return <main className="mx-auto max-w-7xl px-6 py-12"><p>Loading administrative session…</p></main>;
  if (principal.error) return <main className="mx-auto max-w-2xl space-y-4 px-6 py-12"><h1 className="text-3xl font-bold">Administration unavailable</h1><Notice error={principal.error} /><p className="text-sm text-[var(--color-text-muted)]">The canonical Fastify administration API is unavailable.</p></main>;
  if (!principal.data?.user.authenticated) return <main className="mx-auto max-w-2xl space-y-4 px-6 py-12"><h1 className="text-3xl font-bold">Sign-in required</h1><p>Use the existing browser authentication flow, then return here.</p></main>;
  if (!available.length) return <main className="mx-auto max-w-2xl space-y-4 px-6 py-12"><h1 className="text-3xl font-bold">No administrative permissions</h1><p>Your Fastify principal has no administrative capability exposed to this client.</p></main>;
  return <main className="admin-page page-gutter min-w-0 space-y-6 py-10"><header className="space-y-2"><p className="technical-label text-[var(--color-primary)]">PRG32 Cartridge Store</p><h1 className="text-3xl font-bold">Administration</h1><p className="text-sm text-[var(--color-text-muted)]">Signed in as {principal.data.user.username}. Capabilities are supplied by the backend authorization registry.</p></header><div className="grid min-w-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]"><AdminNavigation items={available} selected={section} onSelect={setSection} /><div className="min-w-0"><ActivePanel section={section} /></div></div></main>;
}
