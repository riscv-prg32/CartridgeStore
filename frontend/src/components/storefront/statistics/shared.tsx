import { Activity, BarChart3, type LucideIcon } from "lucide-react";

const accentStyles = {
  violet: "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  blue: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
} as const;

/** Summary card used by the statistics workspace. */
export function StatCard({
  label,
  value,
  detail,
  icon: Icon = Activity,
  accent = "violet",
}: {
  label: string;
  value: string;
  detail: string;
  icon?: LucideIcon;
  accent?: keyof typeof accentStyles;
}) {
  return (
    <article className="surface-card flex min-h-40 flex-col justify-between p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm font-semibold text-[var(--color-text-muted)]">
          {label}
        </p>
        <span
          className={`grid size-10 shrink-0 place-items-center rounded-xl ${accentStyles[accent]}`}
        >
          <Icon aria-hidden="true" className="size-5" />
        </span>
      </div>
      <div>
        <p className="mt-5 text-3xl font-bold tracking-tight tabular-nums">
          {value}
        </p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">{detail}</p>
      </div>
    </article>
  );
}

/** Empty state shared by statistics visualizations. */
export function EmptyChart({
  message,
  className = "",
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      className={[
        "grid min-h-64 place-items-center rounded-xl border border-dashed",
        "border-[var(--color-border)] bg-[var(--color-bg)] px-6 py-8 text-center",
        className,
      ].join(" ")}
    >
      <div>
        <span
          className={[
            "mx-auto grid size-12 place-items-center rounded-xl",
            "bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]",
          ].join(" ")}
        >
          <BarChart3 aria-hidden="true" className="size-6" />
        </span>
        <p className="mt-4 text-sm font-semibold">No activity yet</p>
        <p className="mt-1 max-w-xs text-sm text-[var(--color-text-muted)]">
          {message}
        </p>
      </div>
    </div>
  );
}

/** Small, high-contrast tooltip shared by interactive statistics visuals. */
export function ChartTooltip({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      role="tooltip"
      className={[
        "pointer-events-none z-20 min-w-max rounded-md bg-[var(--color-text)]",
        "px-2.5 py-1.5 text-xs font-semibold text-[var(--color-surface)]",
        "shadow-lg",
        className,
      ].join(" ")}
    >
      <p>{label} · {value}</p>
    </div>
  );
}

export function SkeletonBlock({ className }: { className: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-[var(--color-surface-muted)] ${className}`}
    />
  );
}
