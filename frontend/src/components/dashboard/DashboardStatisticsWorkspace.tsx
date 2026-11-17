"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, BarChart3, Download, Gamepad2, Layers3, PackageCheck, Target } from "lucide-react";
import Link from "next/link";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";

import { adminApi, AdminIntegrationUnavailableError, type AdminCartridge } from "../../lib/api/admin";
import { ApiRequestError } from "../../lib/api/client";
import { getGameDownloadStats, type DownloadStatsQuery } from "../../lib/api/statistics";
import { adminQueryKeys, statisticsQueryKeys } from "../../lib/api/query-keys";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { Badge } from "../ui/badge";
import { StatusMessage } from "../ui/status";
import { DownloadTrend, type DownloadRange } from "../storefront/statistics-presentation";
import { DashboardFrame, DashboardLoading } from "./DashboardFrame";

function useHydrated(): boolean {
  return useSyncExternalStore(() => () => undefined, () => true, () => false);
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0")).join("-");
}

function downloadParams(range: DownloadRange): DownloadStatsQuery {
  const until = new Date().toISOString().slice(0, 10);
  if (range === "week") return { since: dateDaysAgo(6), until, granularity: "day", limit: 30 };
  if (range === "month") return { since: dateDaysAgo(29), until, granularity: "day", limit: 31 };
  if (range === "year") return { since: dateDaysAgo(364), until, granularity: "month", limit: 12 };
  return { granularity: "month", limit: 365 };
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminIntegrationUnavailableError) return "The catalog management service is not available in this environment.";
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return "Your account does not have permission to view publisher statistics.";
    if (error.status >= 500) return "The service is temporarily unavailable. Try again in a moment.";
  }
  return "Something went wrong while loading publisher statistics.";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDate(value: unknown): string {
  if (typeof value !== "string") return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function MetricCard({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: LucideIcon }) {
  return <div className="surface-card p-5"><div className="flex items-start justify-between gap-3"><div><p className="technical-label text-[var(--color-text-muted)]">{label}</p><p className="mt-4 text-3xl font-bold tracking-tight">{value}</p></div><span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><Icon aria-hidden="true" className="size-4" /></span></div><p className="mt-2 text-xs text-[var(--color-text-muted)]">{detail}</p></div>;
}

function PerformanceTable({ items, stats }: { items: AdminCartridge[]; stats: Array<{ total: number; architectures: Array<{ architecture: string; downloads: number }> } | null> }) {
  const rows = items.map((cartridge, index) => ({ cartridge, stats: stats[index] })).sort((left, right) => (right.stats?.total ?? 0) - (left.stats?.total ?? 0));
  if (rows.length === 0) return <p className="p-5 text-sm text-[var(--color-text-muted)]">No published cartridges are available yet.</p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[38rem] text-left text-sm"><caption className="sr-only">Publisher cartridge performance</caption><thead className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] text-xs uppercase tracking-[0.12em] text-[var(--color-text-muted)]"><tr><th scope="col" className="px-5 py-3 font-semibold">Cartridge</th><th scope="col" className="px-4 py-3 font-semibold">Downloads</th><th scope="col" className="px-4 py-3 font-semibold">Targets</th><th scope="col" className="px-5 py-3 font-semibold">Updated</th></tr></thead><tbody className="divide-y divide-[var(--color-border)]">{rows.map(({ cartridge, stats: gameStats }) => <tr key={`${cartridge.id}/${cartridge.selected_version}`} className="hover:bg-[var(--color-surface-muted)]"><td className="px-5 py-3.5"><Link href={`/dashboard/cartridges/${encodeURIComponent(cartridge.id)}/statistics?version=${encodeURIComponent(cartridge.selected_version)}`} className="font-semibold hover:text-[var(--color-primary-strong)]">{cartridge.title}</Link><p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{cartridge.id} · v{cartridge.selected_version}</p></td><td className="px-4 py-3.5 font-semibold tabular-nums">{gameStats ? formatNumber(gameStats.total) : "—"}</td><td className="px-4 py-3.5 text-[var(--color-text-muted)]">{gameStats?.architectures.length ?? Object.keys(cartridge.variants).length}</td><td className="px-5 py-3.5 text-xs text-[var(--color-text-muted)]">{formatDate(cartridge.updated_at)}</td></tr>)}</tbody></table></div>;
}

export function DashboardStatisticsWorkspace() {
  const hydrated = useHydrated();
  const current = useCurrentUser();
  const [range, setRange] = useState<DownloadRange>("month");
  const user = current.user;
  const canManageCatalog = Boolean(user?.permissions?.includes("catalog:metadata:write"));
  const params = downloadParams(range);
  const catalog = useQuery({ queryKey: adminQueryKeys.catalog({ moderation: true, page: 1, limit: 100 }), queryFn: () => adminApi.listModerationInventory({ page: 1, limit: 100 }), enabled: canManageCatalog, retry: false });
  const items = catalog.data?.cartridges ?? [];
  const downloadQueries = useQueries({ queries: items.map((item) => ({ queryKey: statisticsQueryKeys.gameDownloads(item.id, params), queryFn: () => getGameDownloadStats(item.id, params), enabled: canManageCatalog, staleTime: 30_000, retry: false })) });
  const stats = downloadQueries.map((query) => query.data ?? null);
  const series = items.length === 0 ? [] : Array.from(new Set(stats.flatMap((item) => item?.series.map((point) => point.date) ?? []))).sort().map((date) => ({ date, downloads: stats.reduce((total, item) => total + (item?.series.find((point) => point.date === date)?.downloads ?? 0), 0) }));
  const totalDownloads = stats.reduce((total, item) => total + (item?.total ?? 0), 0);
  const targetCount = new Set(items.flatMap((item) => item.architectures)).size;
  const topGame = items.map((item, index) => ({ item, total: stats[index]?.total ?? 0 })).sort((left, right) => right.total - left.total)[0];
  const loading = catalog.isPending || downloadQueries.some((query) => query.isPending);
  const queryError = catalog.error ?? downloadQueries.find((query) => query.error)?.error;

  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to view publisher statistics.</StatusMessage></DashboardFrame>;
  if (!canManageCatalog) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Your account does not have permission to view publisher statistics.</StatusMessage></DashboardFrame>;

  return <DashboardFrame canSubmit={Boolean(user.permissions?.includes("catalog:submit"))}><div className="space-y-8"><header className="border-b border-[var(--color-border)] pb-6"><p className="technical-label text-[var(--color-primary)]">Publisher analytics</p><div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><h1 className="text-3xl font-bold tracking-tight">Statistics</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">Understand how your published cartridges perform across the store. These figures are scoped to your catalog, not the public storefront totals.</p></div><Link href="/dashboard/cartridges" className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--color-primary-strong)] hover:underline">Open catalog <ArrowUpRight aria-hidden="true" className="size-4" /></Link></div></header>{queryError && <StatusMessage tone="warning" className="p-4">{errorMessage(queryError)}</StatusMessage>}{loading ? <DashboardLoading /> : <><section aria-labelledby="publisher-kpis"><div className="mb-4"><p className="technical-label text-[var(--color-primary)]">Your catalog</p><h2 id="publisher-kpis" className="mt-1 text-xl font-bold">Performance at a glance</h2></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Downloads" value={formatNumber(totalDownloads)} detail="Across your published cartridges" icon={Download} /><MetricCard label="Published cartridges" value={formatNumber(items.length)} detail="Currently in the catalog" icon={PackageCheck} /><MetricCard label="Top cartridge" value={topGame?.item.title ?? "—"} detail={topGame ? `${formatNumber(topGame.total)} downloads` : "No download data yet"} icon={Gamepad2} /><MetricCard label="Target footprint" value={formatNumber(targetCount)} detail="Architectures represented" icon={Target} /></div></section><div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]"><section className="surface-card min-w-0 p-5 sm:p-6" aria-labelledby="catalog-downloads-heading"><div className="mb-5 flex items-start gap-3"><span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><BarChart3 aria-hidden="true" className="size-4" /></span><div><h2 id="catalog-downloads-heading" className="font-bold">Catalog downloads</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Combined download activity for your cartridges.</p></div></div><DownloadTrend series={series} range={range} onRangeChange={setRange} /></section><section className="surface-card p-5 sm:p-6" aria-labelledby="target-footprint-heading"><div className="mb-5 flex items-start gap-3"><span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><Layers3 aria-hidden="true" className="size-4" /></span><div><h2 id="target-footprint-heading" className="font-bold">Target footprint</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Architectures available across your catalog.</p></div></div><div className="space-y-3">{Array.from(new Set(items.flatMap((item) => item.architectures))).map((architecture) => <div key={architecture} className="flex items-center justify-between rounded-lg border border-[var(--color-border)] px-3 py-2.5"><span className="text-sm font-semibold">{architecture}</span><span className="text-xs text-[var(--color-text-muted)]">{items.filter((item) => item.architectures.includes(architecture)).length} cartridges</span></div>)}{targetCount === 0 && <p className="text-sm text-[var(--color-text-muted)]">No targets published yet.</p>}</div></section></div><section className="surface-card overflow-hidden" aria-labelledby="performance-heading"><div className="border-b border-[var(--color-border)] px-5 py-4"><p className="technical-label text-[var(--color-primary)]">Release performance</p><h2 id="performance-heading" className="mt-1 text-lg font-bold">Cartridges by downloads</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Open a cartridge to inspect version, target, score and download details.</p></div><PerformanceTable items={items} stats={stats} /></section></>}</div></DashboardFrame>;
}
