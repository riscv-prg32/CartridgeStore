"use client";

import { ArrowLeft, BarChart3, Download, ExternalLink, Gamepad2, Target, Trophy } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";

import { adminApi, AdminIntegrationUnavailableError } from "../../lib/api/admin";
import { ApiRequestError } from "../../lib/api/client";
import { getScores } from "../../lib/api/scores";
import { getGameDownloadStats, type DownloadStatsQuery } from "../../lib/api/statistics";
import { adminQueryKeys, scoresQueryKeys, statisticsQueryKeys } from "../../lib/api/query-keys";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import type { ScoreRecord } from "../../lib/api/contracts";
import { DownloadTrend, type DownloadRange } from "../storefront/statistics-presentation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { StatusMessage } from "../ui/status";
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
    if (error.status === 403) return "Your account does not have permission to view these cartridge statistics.";
    if (error.status === 404) return "This cartridge could not be found in the catalog.";
  }
  return "Something went wrong while loading cartridge statistics.";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatScoreDate(value: number): string {
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "Not available" : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function StatCard({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: typeof Download }) {
  return <div className="surface-card p-5"><div className="flex items-start justify-between gap-3"><div><p className="technical-label text-[var(--color-text-muted)]">{label}</p><p className="mt-4 text-3xl font-bold tracking-tight">{value}</p></div><span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><Icon aria-hidden="true" className="size-4" /></span></div><p className="mt-2 text-xs text-[var(--color-text-muted)]">{detail}</p></div>;
}

function ScoresTable({ scores }: { scores: ScoreRecord[] }) {
  if (scores.length === 0) return <p className="px-5 py-8 text-sm text-[var(--color-text-muted)]">No scores have been recorded for this cartridge yet.</p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-left text-sm"><caption className="sr-only">Top scores for this cartridge</caption><thead className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] text-xs uppercase tracking-[0.12em] text-[var(--color-text-muted)]"><tr><th scope="col" className="px-5 py-3 font-semibold">Player</th><th scope="col" className="px-4 py-3 text-right font-semibold">Score</th><th scope="col" className="px-5 py-3 text-right font-semibold">Submitted</th></tr></thead><tbody className="divide-y divide-[var(--color-border)]">{scores.map((score, index) => <tr key={`${score.player}-${score.created_at}-${index}`}><th scope="row" className="px-5 py-3.5 font-semibold">{score.player}</th><td className="px-4 py-3.5 text-right font-bold tabular-nums">{formatNumber(score.score)}</td><td className="px-5 py-3.5 text-right text-xs text-[var(--color-text-muted)]">{formatScoreDate(score.created_at)}</td></tr>)}</tbody></table></div>;
}

export function DashboardCartridgeStatisticsWorkspace({ cartridgeId }: { cartridgeId: string }) {
  const hydrated = useHydrated();
  const current = useCurrentUser();
  const searchParams = useSearchParams();
  const version = searchParams.get("version") ?? undefined;
  const [range, setRange] = useState<DownloadRange>("month");
  const user = current.user;
  const canManageCatalog = Boolean(user?.permissions?.includes("catalog:metadata:write"));
  const params = downloadParams(range);
  const cartridgeQuery = useQuery({ queryKey: adminQueryKeys.cartridge(cartridgeId, version), queryFn: () => adminApi.getModerationCartridge(cartridgeId, version), enabled: canManageCatalog && cartridgeId.trim().length > 0, retry: false });
  const downloads = useQuery({ queryKey: statisticsQueryKeys.gameDownloads(cartridgeId, params), queryFn: () => getGameDownloadStats(cartridgeId, params), enabled: canManageCatalog && cartridgeId.trim().length > 0, staleTime: 30_000, retry: false });
  const scores = useQuery({ queryKey: scoresQueryKeys.list({ game: cartridgeId, limit: 10 }), queryFn: () => getScores({ game: cartridgeId, limit: 10 }), enabled: canManageCatalog && cartridgeId.trim().length > 0, staleTime: 30_000, retry: false });

  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to view cartridge statistics.</StatusMessage></DashboardFrame>;
  if (!canManageCatalog) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Your account does not have permission to view cartridge statistics.</StatusMessage></DashboardFrame>;

  const cartridge = cartridgeQuery.data?.cartridge;
  const queryError = cartridgeQuery.error ?? downloads.error ?? scores.error;
  const loading = cartridgeQuery.isPending || downloads.isPending || scores.isPending;
  const scoreRows = scores.data ?? [];

  return <DashboardFrame canSubmit={Boolean(user.permissions?.includes("catalog:submit"))}><div className="space-y-8"><header className="border-b border-[var(--color-border)] pb-6"><Link href={`/dashboard/cartridges/${encodeURIComponent(cartridgeId)}${version ? `?version=${encodeURIComponent(version)}` : ""}`} className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--color-primary-strong)] hover:underline"><ArrowLeft aria-hidden="true" className="size-4" />Back to cartridge detail</Link><div className="mt-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="technical-label text-[var(--color-primary)]">Publisher analytics / Cartridge</p><h1 className="mt-2 text-3xl font-bold tracking-tight">{cartridge?.title ?? "Cartridge statistics"}</h1><p className="mt-2 break-all text-sm text-[var(--color-text-muted)]">{cartridgeId}</p></div>{cartridge && <Button asChild variant="secondary"><Link href={`/games/${encodeURIComponent(cartridge.id)}?version=${encodeURIComponent(cartridge.selected_version)}`}><ExternalLink aria-hidden="true" className="size-4" />Open public page</Link></Button>}</div></header>{queryError && <StatusMessage tone="warning" className="p-4">{errorMessage(queryError)}</StatusMessage>}{loading ? <DashboardLoading /> : !cartridge ? <StatusMessage tone="warning" className="p-5">This cartridge is no longer available.</StatusMessage> : <><section aria-labelledby="cartridge-kpis"><div className="mb-4"><p className="technical-label text-[var(--color-primary)]">Release performance</p><h2 id="cartridge-kpis" className="mt-1 text-xl font-bold">{cartridge.title} at a glance</h2></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Downloads" value={formatNumber(downloads.data?.total ?? 0)} detail="Across published targets" icon={Download} /><StatCard label="Targets" value={formatNumber(downloads.data?.architectures.length ?? cartridge.architectures.length)} detail="Architectures with download data" icon={Target} /><StatCard label="Top score" value={scoreRows[0] ? formatNumber(scoreRows[0].score) : "—"} detail={scoreRows[0] ? `By ${scoreRows[0].player}` : "No scores yet"} icon={Trophy} /><StatCard label="Score entries" value={formatNumber(scoreRows.length)} detail="Top entries returned by the Store API" icon={Gamepad2} /></div></section><section className="surface-card min-w-0 p-5 sm:p-6" aria-labelledby="cartridge-downloads-heading"><div className="mb-5 flex items-start gap-3"><span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><BarChart3 aria-hidden="true" className="size-4" /></span><div><h2 id="cartridge-downloads-heading" className="font-bold">Download activity</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Download activity for this bundle ID, split by the selected period.</p></div></div><DownloadTrend series={downloads.data?.series ?? []} range={range} onRangeChange={setRange} /></section><div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]"><section className="surface-card overflow-hidden" aria-labelledby="score-history-heading"><div className="border-b border-[var(--color-border)] px-5 py-4"><p className="technical-label text-[var(--color-primary)]">Player response</p><h2 id="score-history-heading" className="mt-1 text-lg font-bold">Top scores</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Scores recorded for this cartridge only.</p></div><ScoresTable scores={scoreRows} /></section><section className="surface-card p-5 sm:p-6" aria-labelledby="target-breakdown-heading"><div className="mb-5 flex items-start gap-3"><span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><Target aria-hidden="true" className="size-4" /></span><div><h2 id="target-breakdown-heading" className="font-bold">Target breakdown</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Downloads by architecture.</p></div></div><div className="space-y-3">{(downloads.data?.architectures ?? []).map((target) => <div key={target.architecture} className="flex items-center justify-between rounded-lg border border-[var(--color-border)] px-3 py-2.5"><span className="text-sm font-semibold">{target.architecture}</span><span className="text-sm tabular-nums text-[var(--color-text-muted)]">{formatNumber(target.downloads)}</span></div>)}{(downloads.data?.architectures.length ?? 0) === 0 && <p className="text-sm text-[var(--color-text-muted)]">No target downloads yet.</p>}</div></section></div></>}</div></DashboardFrame>;
}
