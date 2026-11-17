"use client";

import { BookOpen, ChevronRight, CirclePlus } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";

import { DashboardNav } from "./DashboardNav";

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="flex flex-col justify-between gap-5 border-b border-[var(--color-border)] pb-6 sm:flex-row sm:items-end"><div><p className="technical-label text-[var(--color-primary)]">{eyebrow}</p><h1 className="mt-2 text-3xl font-bold tracking-tight">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">{description}</p></div>{action}</header>;
}
export function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
}
export function DashboardFrame({ children, canSubmit }: { children: ReactNode; canSubmit: boolean }) {
  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[var(--color-surface-muted)]">
      <div className="grid min-h-[calc(100vh-4rem)] lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="dashboard-sidebar border-b border-[var(--color-border)] px-4 py-5 lg:sticky lg:top-16 lg:flex lg:h-[calc(100vh-4rem)] lg:flex-col lg:self-start lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-5 lg:py-8">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="technical-label text-[var(--color-primary)]">
                Store workspace
              </p>
              <h2 className="mt-1 text-lg font-bold tracking-tight">
                Developer dashboard
              </h2>
              <p className="mt-1 hidden text-xs leading-5 text-[var(--color-text-muted)] lg:block">
                Build and manage cartridges for the PRG32 Store.
              </p>
            </div>
            <Link
              href="/dashboard/publish"
              className="inline-flex items-center gap-2 rounded-md bg-[var(--color-primary)] px-3 py-2 text-xs font-semibold text-white shadow-[var(--shadow-brand)] hover:bg-[var(--color-primary-strong)] lg:hidden"
            >
              <CirclePlus aria-hidden="true" className="size-3.5" />
              New
            </Link>
          </div>

          <div className="mt-7 overflow-x-auto border-t border-[var(--color-border)] pt-6 pb-1 lg:mt-9 lg:overflow-visible">
            <DashboardNav canSubmit={canSubmit} />
          </div>

          <Link
            href="/docs"
            className="mt-auto hidden items-center gap-2 border-t border-[var(--color-border)] pt-5 text-sm font-semibold text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-primary-strong)] lg:flex"
          >
            <BookOpen aria-hidden="true" className="size-4" />
            <span>Cartridge docs</span>
            <ChevronRight aria-hidden="true" className="ml-auto size-4" />
          </Link>
        </aside>
        <main className="relative min-w-0 overflow-hidden px-4 py-5 sm:px-6 lg:px-10 lg:py-8 xl:px-14">
          <div className="pointer-events-none absolute inset-0 opacity-35" style={{ backgroundImage: "linear-gradient(color-mix(in srgb, var(--color-border) 62%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color-border) 62%, transparent) 1px, transparent 1px)", backgroundSize: "2.5rem 2.5rem", maskImage: "linear-gradient(90deg, black, transparent 90%)" }} />
          <div className="relative">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export function DashboardLoading() {
  return <div className="space-y-5" aria-busy="true"><div className="h-36 animate-pulse rounded-2xl bg-[var(--color-surface)]" /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-32 animate-pulse rounded-xl bg-[var(--color-surface)]" />)}</div></div>;
}
