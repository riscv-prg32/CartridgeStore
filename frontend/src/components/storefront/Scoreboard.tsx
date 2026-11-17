"use client";

import { FormEvent, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronRight, Gamepad2, ListOrdered, Medal, RefreshCw, SlidersHorizontal, Trophy, UserRound } from "lucide-react";

import type { ScoreRecord } from "../../lib/api/contracts";
import { getCatalog } from "../../lib/api/catalog";
import { scoresQueryKeys } from "../../lib/api/query-keys";
import { catalogQueryKeys } from "../../lib/api/query-keys";
import { getScores } from "../../lib/api/scores";
import { ComboboxField } from "../ui/combobox";
import { SelectField, SelectItem } from "../ui/select";
import { formatScoreDate } from "./formatters";

function limitValue(value: string | null): number {
  return value === "50" || value === "100" ? Number(value) : 20;
}

function setUrl(pathname: string, values: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  const suffix = query.toString();
  window.history.replaceState(window.history.state, "", `${pathname}${suffix ? `?${suffix}` : ""}`);
}

function SpotlightEntry({ score, position }: { score: ScoreRecord; position: number }) {
  const isWinner = position === 1;
  return (
    <article className="relative flex min-h-44 flex-col justify-between p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className={`flex size-10 items-center justify-center rounded-lg border ${isWinner ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]"}`}>
          {isWinner ? <Trophy aria-hidden="true" className="size-5" /> : <Medal aria-hidden="true" className="size-5" />}
        </div>
        <span className="technical-label text-[var(--color-text-muted)]">{String(position).padStart(2, "0")}</span>
      </div>
      <div className="mt-8">
        <p className="truncate text-lg font-semibold">{score.player}</p>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]"><Gamepad2 aria-hidden="true" className="size-3.5" />{score.game}</p>
      </div>
      <p className="mt-5 text-3xl font-bold tracking-tight tabular-nums">{score.score.toLocaleString("en-US")}</p>
    </article>
  );
}

function LoadingState() {
  return <div className="border-y border-[var(--color-border)] py-8" aria-busy="true"><div className="h-4 w-36 animate-pulse bg-[var(--color-surface-muted)]" /><div className="mt-5 h-12 w-full animate-pulse bg-[var(--color-surface-muted)]" /><div className="mt-3 h-12 w-full animate-pulse bg-[var(--color-surface-muted)]" /></div>;
}

export function Scoreboard() {
  const pathname = usePathname();
  const params = useSearchParams();
  const game = params.get("game") ?? "";
  const player = params.get("player") ?? "";
  const limit = limitValue(params.get("limit"));
  const [selectedLimit, setSelectedLimit] = useState(String(limit));
  const gamesQuery = useQuery({ queryKey: catalogQueryKeys.list({ perPage: 100 }), queryFn: () => getCatalog({ perPage: 100 }), staleTime: 30_000, retry: false });
  const query = useQuery({ queryKey: scoresQueryKeys.list({ game, player, limit }), queryFn: () => getScores({ game, player, limit }), placeholderData: keepPreviousData, staleTime: 15_000, retry: false });
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const gameOptions = useMemo(() => {
    const catalogGames = gamesQuery.data?.games.map((item) => ({ value: item.id, label: item.title || item.id })) ?? [];
    const scoreGames = rows.map((item) => ({ value: item.game, label: item.game }));
    return Array.from(new Map([...catalogGames, ...scoreGames].map((item) => [item.value, item])).values()).sort((left, right) => left.label.localeCompare(right.label));
  }, [gamesQuery.data?.games, rows]);
  const spotlight = rows.slice(0, 3);
  const hasFilters = Boolean(game || player || params.get("limit"));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextGame = String(form.get("game") ?? "").trim();
    const nextPlayer = String(form.get("player") ?? "").trim();
    const nextLimit = String(form.get("limit") ?? "20");
    setUrl(pathname, { game: nextGame || undefined, player: nextPlayer || undefined, limit: nextLimit === "20" ? undefined : nextLimit });
  }

  function clearFilters() {
    setSelectedLimit("20");
    setUrl(pathname, {});
  }

  return (
    <main className="scoreboard-page page-gutter py-8 sm:py-12">
      <div className="mx-auto max-w-[96rem]">
      <header className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-7 shadow-[var(--shadow-card)] sm:px-8 sm:py-9">
        <div>
          <p className="technical-label text-[var(--color-primary)]">PRG32 / Leaderboard</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">Scoreboard</h1>
          <p className="mt-4 max-w-3xl text-[var(--color-text-muted)]">The best runs from the Cartridge Store, ordered exactly as returned by the Store API.</p>
        </div>
      </header>

      <form key={`${game}:${player}:${limit}`} className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-6 shadow-[var(--shadow-card)] sm:px-8" onSubmit={submit}>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div><div className="flex items-center gap-2"><SlidersHorizontal aria-hidden="true" className="size-4 text-[var(--color-primary)]" /><h2 className="font-semibold">Explore the rankings</h2></div><p className="mt-1 text-sm text-[var(--color-text-muted)]">Narrow the board by game, player or number of rows.</p></div>
          {hasFilters && <button type="button" onClick={clearFilters} className="text-sm font-semibold text-[var(--color-primary)] underline-offset-4 hover:underline">Clear filters</button>}
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_auto] lg:items-end">
          <ComboboxField label="Game" name="game" value={game} options={gameOptions} placeholder="All games" icon={<Gamepad2 aria-hidden="true" className="size-4 text-[var(--color-text-muted)]" />} />
          <label className="text-sm font-semibold"><span className="flex items-center gap-2"><UserRound aria-hidden="true" className="size-4 text-[var(--color-text-muted)]" />Player</span><input name="player" aria-label="Filter scores by player" defaultValue={player} className="mt-2 min-h-11 w-full rounded-lg border border-[var(--color-input)] bg-[var(--color-bg)] px-3 outline-none transition-colors placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-soft)]" placeholder="All players" /></label>
          <SelectField label="Rows" icon={<ListOrdered aria-hidden="true" className="size-4 text-[var(--color-text-muted)]" />} value={selectedLimit} onValueChange={setSelectedLimit}><SelectItem value="20">20</SelectItem><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectField>
          <input type="hidden" name="limit" value={selectedLimit} />
          <button className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition-colors hover:bg-[var(--color-primary-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]" type="submit">Apply filters<ChevronRight aria-hidden="true" className="size-4" /></button>
        </div>
        <div className="mt-5 flex items-center gap-2 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-text-muted)]"><Trophy aria-hidden="true" className="size-3.5 text-[var(--color-primary)]" />Positions are calculated within the current view and preserve the Store API order.</div>
      </form>

      {query.isPending && <LoadingState />}
      {query.isError && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-6 py-6 text-rose-950 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-100" role="alert"><h2 className="font-semibold">The scoreboard could not be loaded.</h2><p className="mt-2 text-sm">The score API may be temporarily unavailable. Try again in a moment.</p><button type="button" className="mt-4 inline-flex items-center gap-2 rounded-lg border border-current px-3 py-2 text-sm font-semibold" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" className="size-4" />Try again</button></div>}
      {query.isSuccess && rows.length === 0 && <section className="mt-5 grid gap-8 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-12 shadow-[var(--shadow-card)] sm:px-8 sm:py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-12" aria-labelledby="empty-scoreboard-heading"><div className="flex items-start gap-4 md:block"><div className="grid size-20 shrink-0 place-items-center rounded-xl border border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"><Trophy aria-hidden="true" className="size-9" /></div><p className="technical-label mt-0.5 text-[var(--color-text-muted)] md:mt-5">00 / No entries</p></div><div className="max-w-xl"><h2 id="empty-scoreboard-heading" className="text-2xl font-bold tracking-tight">No scores match these filters.</h2><p className="mt-3 text-[var(--color-text-muted)]">Try another game or player, or clear the filters to see the complete board.</p><div className="mt-7 grid gap-4 border-t border-[var(--color-border)] pt-5 text-sm sm:grid-cols-2"><div><p className="font-semibold">What appears here</p><p className="mt-1 text-[var(--color-text-muted)]">Published runs ordered by score and submission time.</p></div><div><p className="font-semibold">Useful starting point</p><p className="mt-1 text-[var(--color-text-muted)]">Leave Game and Player empty to browse every result.</p></div></div></div></section>}
      {query.isSuccess && rows.length > 0 && <>
        <section className="mt-10 border-b border-[var(--color-border)]" aria-labelledby="spotlight-heading">
          <div className="flex items-end justify-between gap-4 border-b border-[var(--color-border)] pb-4"><div><p className="technical-label text-[var(--color-primary)]">01 / Spotlight</p><h2 id="spotlight-heading" className="mt-2 text-2xl font-bold tracking-tight">Top of this view</h2></div><p className="hidden text-sm text-[var(--color-text-muted)] sm:block">{rows.length} result{rows.length === 1 ? "" : "s"}</p></div>
          <div className="grid overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] md:grid-cols-3 md:divide-x md:divide-y-0">{spotlight.map((score, index) => <SpotlightEntry key={`${score.game}-${score.player}-${score.created_at}-${index}`} score={score} position={index + 1} />)}</div>
        </section>
        <section className="mt-10" aria-labelledby="score-table-heading">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-border)] pb-4"><div><p className="technical-label text-[var(--color-primary)]">02 / Full list</p><h2 id="score-table-heading" className="mt-2 text-2xl font-bold tracking-tight">Scores in this view</h2></div><p className="text-sm text-[var(--color-text-muted)]">Up to {limit} rows</p></div>
          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"><table className="w-full min-w-[38rem] text-left text-sm"><caption className="sr-only">PRG32 scoreboard results</caption><thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-text-muted)]"><tr><th className="px-3 py-3 font-semibold">Position</th><th className="px-3 py-3 font-semibold">Game</th><th className="px-3 py-3 font-semibold">Player</th><th className="px-3 py-3 font-semibold">Score</th><th className="px-3 py-3 font-semibold">Submitted</th></tr></thead><tbody>{rows.map((score, index) => <tr key={`${score.game}-${score.player}-${score.created_at}-${index}`} className="border-b border-[var(--color-border)] transition-colors last:border-0 hover:bg-[var(--color-surface-muted)]"><th scope="row" className="px-3 py-4 font-semibold tabular-nums text-[var(--color-text-muted)]">{String(index + 1).padStart(2, "0")}</th><td className="px-3 py-4 font-medium">{score.game}</td><td className="px-3 py-4">{score.player}</td><td className="px-3 py-4 font-semibold tabular-nums">{score.score.toLocaleString("en-US")}</td><td className="px-3 py-4 text-[var(--color-text-muted)]">{formatScoreDate(score.created_at)}</td></tr>)}</tbody></table></div>
        </section>
      </>}
      </div>
    </main>
  );
}
