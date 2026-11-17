"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { useCurrentUser } from "../../lib/auth/use-current-user";
import { hasFederationPermission } from "./FederationAdminGuard";

export function FederationAdminShell({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const current = useCurrentUser();
  const manage = hasFederationPermission(current.user, "federation:manage");
  const links = [
    { href: "/admin/federation", label: "Overview" },
    { href: "/admin/federation/providers", label: "Providers" },
    { href: "/admin/federation/identities", label: "Identity links" },
  ];
  return <main className="page-gutter py-8"><div className="flex flex-col gap-6 lg:flex-row"><aside className="lg:w-52"><p className="technical-label text-[var(--color-primary)]">Administration</p><h1 className="mt-1 text-2xl font-bold">Federation</h1><nav className="mt-5 grid gap-1" aria-label="Federation administration">{links.map((link) => <Link key={link.href} href={link.href} className={`rounded-lg px-3 py-2 text-sm font-medium ${pathname === link.href ? "bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]" : "hover:bg-[var(--color-surface-muted)]"}`}>{link.label}</Link>)}{manage && <Link href="/admin/federation/providers/new" className="mt-3 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-center text-sm font-semibold text-white hover:bg-[var(--color-primary-strong)]">Add provider</Link>}</nav></aside><div className="min-w-0 flex-1">{children}</div></div></main>;
}
