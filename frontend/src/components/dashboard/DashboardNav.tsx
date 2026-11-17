"use client";

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Box,
  ClipboardList,
  ChevronDown,
  FolderKanban,
  LayoutDashboard,
  Mail,
  MailOpen,
  Palette,
  RadioTower,
  Rocket,
  Settings2,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { useCurrentUser } from "../../lib/auth/use-current-user";

type DashboardNavChild = {
  label: string;
  href: string;
  icon: LucideIcon;
};

type DashboardNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  section: "Workspace" | "Account";
  children?: readonly DashboardNavChild[];
};

const dashboardNav: DashboardNavItem[] = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboard, section: "Workspace" },
  { label: "My cartridges", href: "/dashboard/cartridges", icon: Box, section: "Workspace" },
  { label: "Drafts", href: "/dashboard/drafts", icon: FolderKanban, section: "Workspace" },
  { label: "Statistics", href: "/dashboard/statistics", icon: BarChart3, section: "Workspace" },
  { label: "Audit trail", href: "/dashboard/audit", icon: ClipboardList, section: "Workspace" },
  {
    label: "Settings",
    href: "/dashboard/settings",
    icon: Settings2,
    section: "Account",
    children: [
      { label: "General", href: "/dashboard/settings/general", icon: SlidersHorizontal },
      { label: "Appearance", href: "/dashboard/settings/appearance", icon: Palette },
      { label: "Registration", href: "/dashboard/settings/registration", icon: UserRound },
      { label: "Publishing", href: "/dashboard/settings/publishing", icon: Rocket },
      { label: "Telemetry", href: "/dashboard/settings/telemetry", icon: Activity },
      { label: "Discovery", href: "/dashboard/settings/discovery", icon: RadioTower },
      { label: "Email delivery", href: "/dashboard/settings/email", icon: Mail },
      { label: "Email templates", href: "/dashboard/settings/email-templates", icon: MailOpen },
    ],
  },
  { label: "Account", href: "/dashboard/account", icon: UserRound, section: "Account" },
];

function useHydrated(): boolean {
  return useSyncExternalStore(() => () => undefined, () => true, () => false);
}

export function DashboardNav({ canSubmit }: { canSubmit: boolean }) {
  const pathname = usePathname();
  const current = useCurrentUser();
  const hydrated = useHydrated();
  const canViewAudit = hydrated && (current.user?.role === "admin" || Boolean(current.user?.permissions?.includes("settings:read")));
  const visibleNav = canViewAudit ? dashboardNav : dashboardNav.filter((item) => item.href !== "/dashboard/audit");
  const showPublishCta = canSubmit && pathname === "/dashboard";
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  return (
    <nav aria-label="Developer dashboard" className="space-y-0.5">
      {visibleNav.map((item, index) => {
        const Icon = item.icon;
        const childActive = item.children?.some(
          (child) => pathname === child.href || pathname.startsWith(`${child.href}/`),
        ) ?? false;
        const active = item.children
          ? pathname === item.href
          : pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
        const groupExpanded = expandedGroups[item.href] ?? (active || childActive);

        return (
          <div key={item.href}>
            {(index === 0 || visibleNav[index - 1]?.section !== item.section) && (
              <p className={`${index === 0 ? "" : "mt-4"} mb-1.5 px-3 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-[var(--color-text-muted)]`}>
                {item.section}
              </p>
            )}
            <div className="relative">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`group flex items-center gap-3 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${item.children ? "pr-10" : ""} ${active ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-primary-strong)]"}`}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span>{item.label}</span>
                {!item.children && active && <span aria-hidden="true" className="ml-auto size-1.5 rounded-full bg-[var(--color-primary)]" />}
              </Link>
              {item.children ? (
                <button
                  type="button"
                  aria-controls={`dashboard-submenu-${item.href.replaceAll("/", "-")}`}
                  aria-expanded={groupExpanded}
                  aria-label={`${groupExpanded ? "Collapse" : "Expand"} ${item.label}`}
                  className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-current transition-colors hover:text-[var(--color-primary-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]"
                  onClick={() => setExpandedGroups((current) => ({ ...current, [item.href]: !groupExpanded }))}
                >
                  <ChevronDown aria-hidden="true" className={`size-4 transition-transform duration-200 ${groupExpanded ? "rotate-180" : ""}`} />
                </button>
              ) : null}
            </div>
            {item.children ? (
              <div
                id={`dashboard-submenu-${item.href.replaceAll("/", "-")}`}
                aria-hidden={!groupExpanded}
                className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out ${groupExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
              >
                <div className="min-h-0 overflow-hidden border-l border-[var(--color-border)] pl-3 pt-1">
                  <div className="grid gap-0.5">
                    {item.children.map((child) => {
                      const ChildIcon = child.icon;
                      const childSelected = pathname === child.href || pathname.startsWith(`${child.href}/`);
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          tabIndex={groupExpanded ? 0 : -1}
                          aria-current={childSelected ? "page" : undefined}
                          className={[
                            "flex items-center gap-2 rounded-md border px-2.5 py-1.5",
                            "text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]",
                            childSelected
                              ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"
                              : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-primary-strong)]",
                          ].join(" ")}
                        >
                          <ChildIcon aria-hidden="true" className="size-3.5 shrink-0" />
                          <span>{child.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {showPublishCta && (
        <Link href="/dashboard/publish" className="mt-4 flex items-center gap-3 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition-colors hover:bg-[var(--color-primary-strong)]">
          <Rocket aria-hidden="true" className="size-4 shrink-0" />
          <span>Publish new</span>
          <ArrowUpRight aria-hidden="true" className="ml-auto size-4" />
        </Link>
      )}
    </nav>
  );
}
