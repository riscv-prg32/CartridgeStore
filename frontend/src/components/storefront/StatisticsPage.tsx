"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BarChart3, Download, Gamepad2, Trophy } from "lucide-react";

import { getDownloadStats, getRunStats, getScoreStats, type DownloadStatsQuery } from "../../lib/api/statistics";
import { statisticsQueryKeys } from "../../lib/api/query-keys";
import {
  DownloadTrend,
  DownloadTrendSkeleton,
  RunHealth,
  RunHealthSkeleton,
  ScorePreview,
  ScorePreviewSkeleton,
  StatisticsError,
  TopGames,
  TopGamesSkeleton,
  type DownloadRange,
} from "./statistics-presentation";

function formatQueryDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
    .join("-");
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return formatQueryDate(date);
}

function downloadParams(range: DownloadRange): DownloadStatsQuery {
  const until = formatQueryDate(new Date());
  if (range === "week") return { since: dateDaysAgo(6), until, granularity: "day", limit: 30 };
  if (range === "month") return { since: dateDaysAgo(29), until, granularity: "day", limit: 31 };
  if (range === "year") return { since: dateDaysAgo(364), until, granularity: "month", limit: 12 };
  return { granularity: "month", limit: 365 };
}

export function StatisticsPage() {
  const [downloadRange, setDownloadRange] = useState<DownloadRange>("month");
  const currentDownloadParams = downloadParams(downloadRange);
  const downloads = useQuery({ queryKey: statisticsQueryKeys.downloads(currentDownloadParams), queryFn: () => getDownloadStats(currentDownloadParams), staleTime: 30_000, retry: false });
  const scores = useQuery({ queryKey: statisticsQueryKeys.scores(5), queryFn: () => getScoreStats(5), staleTime: 30_000, retry: false });
  const runs = useQuery({ queryKey: statisticsQueryKeys.runs(), queryFn: getRunStats, staleTime: 30_000, retry: false });

  const loading = downloads.isPending || scores.isPending || runs.isPending;

  return (
    <main className="page-gutter py-8 sm:py-10">
      <header className="surface-card relative overflow-hidden p-6 sm:p-8 lg:p-10">
        <div className="pointer-events-none absolute -right-24 -top-28 size-80 rounded-full bg-[var(--color-primary-soft)] opacity-60 blur-3xl" />
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl items-start gap-4">
            <span className="hidden size-12 shrink-0 place-items-center rounded-xl bg-[var(--color-primary)] text-white shadow-[var(--shadow-brand)] sm:grid"><BarChart3 aria-hidden="true" className="size-6" /></span>
            <div>
              <p className="technical-label text-[var(--color-primary)]">Store telemetry</p>
              <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">Statistics</h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--color-text-muted)]">A clear view of downloads, player activity and published scores across the Cartridge Store.</p>
            </div>
          </div>
          <div className="relative flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <span className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><span className="size-2 rounded-full bg-emerald-500" />Live public data</span>
            <Link className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition hover:bg-[var(--color-primary-strong)] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-ring)]" href="/scores">Open scoreboard <ArrowUpRight aria-hidden="true" className="size-4" /></Link>
          </div>
        </div>
      </header>

      {loading && <p className="sr-only" aria-live="polite">Loading published statistics…</p>}

      <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.85fr)]" aria-label="Download analytics">
        <article className="surface-card min-w-0 p-5 sm:p-6">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div><div className="flex items-center gap-2"><Download aria-hidden="true" className="size-5 text-[var(--color-primary)]" /><h2 className="text-xl font-bold">Download activity</h2></div><p className="mt-1 text-sm text-[var(--color-text-muted)]">Download events for the selected period.</p></div>
          </div>
          {downloads.isPending ? <DownloadTrendSkeleton /> : downloads.isError ? <StatisticsError label="Download activity" /> : downloads.data ? <DownloadTrend series={downloads.data.series} range={downloadRange} onRangeChange={setDownloadRange} /> : null}
        </article>
        <article className="surface-card flex min-h-0 min-w-0 flex-col p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Trophy aria-hidden="true" className="size-5 text-amber-600" /><h2 className="text-xl font-bold">Most downloaded</h2></div><p className="mt-1 text-sm text-[var(--color-text-muted)]">Top cartridges by event count.</p></div><Gamepad2 aria-hidden="true" className="size-5 text-[var(--color-text-muted)]" /></div>
          {downloads.isPending ? <TopGamesSkeleton /> : downloads.isError ? <StatisticsError label="Top games" /> : downloads.data ? <TopGames games={downloads.data.top_games} /> : null}
        </article>
      </section>

      <section className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]" aria-label="Run and score analytics">
        <article className="surface-card p-5 sm:p-6">
          <div className="mb-6 flex items-start gap-2"><BarChart3 aria-hidden="true" className="size-5 text-[var(--color-primary)]" /><div><h2 className="text-xl font-bold">Run health</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Completion across recorded metrics runs.</p></div></div>
          {runs.isPending ? <RunHealthSkeleton /> : runs.data ? <RunHealth total={runs.data.total} finished={runs.data.finished} active={runs.data.active_last_7_days} /> : <div className="rounded-xl bg-[var(--color-bg)] p-4 text-sm text-[var(--color-text-muted)]">Run health is not available right now.</div>}
        </article>
        <article className="surface-card min-w-0 p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Trophy aria-hidden="true" className="size-5 text-amber-600" /><h2 className="text-xl font-bold">Scoreboard pulse</h2></div><p className="mt-1 text-sm text-[var(--color-text-muted)]">The highest scores currently returned by the Store API.</p></div><Link className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--color-primary-strong)] hover:underline" href="/scores">View all <ArrowUpRight aria-hidden="true" className="size-4" /></Link></div>
          {scores.isPending ? <ScorePreviewSkeleton /> : scores.isError ? <StatisticsError label="Score activity" /> : scores.data ? <ScorePreview scores={scores.data.scores} /> : null}
        </article>
      </section>

    </main>
  );
}
