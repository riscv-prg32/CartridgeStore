import { Activity, CheckCircle2, Gauge } from "lucide-react";

import { formatStatisticsNumber } from "./formatters";
import { ChartTooltip, SkeletonBlock } from "./shared";
import { useState } from "react";

/** Renders the run completion summary. */
export function RunHealth({
  total,
  finished,
  active,
}: {
  total: number;
  finished: number;
  active: number;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const completion = total > 0 ? Math.min((finished / total) * 100, 100) : 0;
  return (
    <div
      className={[
        "grid gap-7 sm:mx-auto sm:max-w-2xl",
        "sm:grid-cols-[7rem_minmax(0,24rem)] sm:items-center",
        "sm:justify-center sm:gap-10",
      ].join(" ")}
    >
      <div className="relative">
      <div
        className="grid size-28 place-items-center rounded-full border-[10px] border-[var(--color-surface-muted)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        tabIndex={0}
        role="img"
        aria-label={`${formatStatisticsNumber(finished)} of ${formatStatisticsNumber(total)} runs completed (${Math.round(completion)}%)`}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onFocus={() => setShowTooltip(true)}
        onBlur={() => setShowTooltip(false)}
        style={{
          background: `conic-gradient(var(--color-primary) ${completion}%, transparent 0)`,
        }}
      >
        <div
          className={[
            "flex size-20 translate-y-1 flex-col items-center justify-center",
            "gap-1 rounded-full bg-[var(--color-surface)] text-center",
          ].join(" ")}
        >
          <span className="text-xl font-bold leading-none tabular-nums">
            {Math.round(completion)}%
          </span>
          <span className="text-[10px] leading-none text-[var(--color-text-muted)]">
            finished
          </span>
        </div>
      </div>
      {showTooltip && <div className="absolute bottom-[calc(100%+0.65rem)] left-1/2 -translate-x-1/2"><ChartTooltip label="Run completion" value={`${formatStatisticsNumber(finished)} / ${formatStatisticsNumber(total)} completed`} /></div>}
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <CheckCircle2 aria-hidden="true" className="size-4 text-emerald-600" />
            Completed runs
          </span>
          <strong className="tabular-nums">{formatStatisticsNumber(finished)}</strong>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Gauge aria-hidden="true" className="size-4 text-violet-600" />
            Total runs
          </span>
          <strong className="tabular-nums">{formatStatisticsNumber(total)}</strong>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Activity aria-hidden="true" className="size-4 text-blue-600" />
            Active in 7 days
          </span>
          <strong className="tabular-nums">{formatStatisticsNumber(active)}</strong>
        </div>
      </div>
    </div>
  );
}

/** Loading state for the run completion summary. */
export function RunHealthSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading run health"
      className={[
        "grid gap-7 sm:mx-auto sm:max-w-2xl",
        "sm:grid-cols-[7rem_minmax(0,24rem)] sm:items-center",
        "sm:justify-center sm:gap-10",
      ].join(" ")}
    >
      <SkeletonBlock className="size-28 rounded-full" />
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <SkeletonBlock className="size-4 rounded-full" />
              <SkeletonBlock className="h-4 w-32" />
            </div>
            <SkeletonBlock className="h-4 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}
