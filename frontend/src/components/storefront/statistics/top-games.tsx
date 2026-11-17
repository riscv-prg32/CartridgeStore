import Link from "next/link";

import { formatStatisticsNumber } from "./formatters";
import { ChartTooltip, EmptyChart, SkeletonBlock } from "./shared";

/** Loading state for the most-downloaded games list. */
export function TopGamesSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading most downloaded games"
      className="min-h-0 flex-1 overflow-hidden pr-2"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className={[
            "grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 border-b",
            "border-[var(--color-border)] py-4 first:pt-0 last:border-0",
          ].join(" ")}
        >
          <SkeletonBlock className="h-4 w-6" />
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-4 w-8" />
            </div>
            <SkeletonBlock className="h-2 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Renders the ranked most-downloaded cartridges list. */
export function TopGames({
  games,
}: {
  games: Array<{ id: string; title: string; downloads: number }>;
}) {
  if (games.length === 0) {
    return (
      <EmptyChart
        className="min-h-0 flex-1"
        message="No downloaded cartridges are recorded yet."
      />
    );
  }

  const maximum = Math.max(...games.map((game) => game.downloads), 1);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pr-2">
      <ol>
        {games.map((game, index) => (
          <li
            key={game.id}
            className={[
              "group relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 border-b",
              "border-[var(--color-border)] py-4 first:pt-0 last:border-0",
            ].join(" ")}
          >
            <span
              className={[
                "pt-0.5 text-xs font-semibold tabular-nums",
                index === 0
                  ? "text-[var(--color-primary)]"
                  : "text-[var(--color-text-muted)]",
              ].join(" ")}
            >
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-3">
                <Link
                  className={[
                    "min-w-0 truncate text-sm font-semibold transition-colors",
                    "group-hover:text-[var(--color-primary-strong)]",
                  ].join(" ")}
                  href={`/games/${encodeURIComponent(game.id)}`}
                >
                  {game.title}
                </Link>
                <span className="shrink-0 text-sm font-bold tabular-nums">
                  {formatStatisticsNumber(game.downloads)}
                </span>
              </div>
              <div
                className="relative mt-3 h-2 overflow-visible rounded-full bg-[var(--color-surface-muted)]"
                aria-label={`${game.title}: ${formatStatisticsNumber(game.downloads)} downloads`}
              >
                <div
                  className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-300"
                  style={{
                    width: `${Math.max((game.downloads / maximum) * 100, 4)}%`,
                  }}
                />
                <ChartTooltip
                  label={game.title}
                  value={`${formatStatisticsNumber(game.downloads)} downloads`}
                  className={[
                    "absolute bottom-[calc(100%+0.55rem)] left-1/2",
                    "-translate-x-1/2 translate-y-1 opacity-0 transition",
                    "group-hover:translate-y-0 group-hover:opacity-100",
                    "group-focus-within:translate-y-0 group-focus-within:opacity-100",
                  ].join(" ")}
                />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
