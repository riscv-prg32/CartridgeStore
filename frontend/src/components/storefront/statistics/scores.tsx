import type { ScoreRecord } from "../../../lib/api/contracts";

import { formatScoreDate } from "../formatters";
import { StatusMessage } from "../../ui/status";
import { formatStatisticsNumber } from "./formatters";
import { EmptyChart, SkeletonBlock } from "./shared";

/** Renders the latest score records. */
export function ScorePreview({ scores }: { scores: ScoreRecord[] }) {
  if (scores.length === 0) {
    return <EmptyChart message="No scores are available yet." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <caption className="sr-only">Top scores preview</caption>
        <thead
          className={[
            "border-b border-[var(--color-border)] text-xs uppercase",
            "tracking-wide text-[var(--color-text-muted)]",
          ].join(" ")}
        >
          <tr>
            <th className="px-3 py-3">#</th>
            <th className="px-3 py-3">Game</th>
            <th className="px-3 py-3">Player</th>
            <th className="px-3 py-3 text-right">Score</th>
            <th className="px-3 py-3 text-right">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((score, index) => (
            <tr
              key={`${score.game}-${score.player}-${score.created_at}-${index}`}
              className="border-b border-[var(--color-border)] last:border-0"
            >
              <td className="px-3 py-3 font-semibold text-[var(--color-text-muted)]">
                {String(index + 1).padStart(2, "0")}
              </td>
              <th scope="row" className="px-3 py-3 font-semibold">
                {score.game}
              </th>
              <td className="px-3 py-3 text-[var(--color-text-muted)]">
                {score.player}
              </td>
              <td className="px-3 py-3 text-right font-bold tabular-nums">
                {formatStatisticsNumber(score.score)}
              </td>
              <td className="px-3 py-3 text-right text-[var(--color-text-muted)]">
                {formatScoreDate(score.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Loading state for the score preview table. */
export function ScorePreviewSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading scoreboard pulse"
      className="overflow-hidden"
    >
      <div className="mb-3 flex gap-3 border-b border-[var(--color-border)] pb-3">
        {Array.from({ length: 5 }, (_, index) => (
          <SkeletonBlock
            key={index}
            className={`h-3 ${index === 0 ? "w-6" : index === 3 || index === 4 ? "w-16" : "w-20"}`}
          />
        ))}
      </div>
      <div className="space-y-4">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="grid grid-cols-[1.5rem_minmax(6rem,1fr)_minmax(5rem,0.8fr)_4rem_5rem] items-center gap-3"
          >
            <SkeletonBlock className="h-4 w-5" />
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-4 w-20" />
            <SkeletonBlock className="h-4 w-12 justify-self-end" />
            <SkeletonBlock className="h-4 w-16 justify-self-end" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Error state shared by statistics data panels. */
export function StatisticsError({ label }: { label: string }) {
  return (
    <StatusMessage tone="danger" className="rounded-xl p-4">
      {label} could not be loaded. The Store API may be temporarily unavailable.
    </StatusMessage>
  );
}
