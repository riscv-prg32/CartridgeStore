"use client";

import type { DownloadSeriesPoint } from "../../../lib/api/contracts";
import { useState } from "react";

import { formatChartDate, formatStatisticsNumber } from "./formatters";
import { ChartTooltip, SkeletonBlock } from "./shared";

export type DownloadRange = "week" | "month" | "year" | "all";

const downloadRangeOptions: Array<{ value: DownloadRange; label: string }> = [
  { value: "week", label: "1 Week" },
  { value: "month", label: "1 Month" },
  { value: "year", label: "1 Year" },
  { value: "all", label: "All" },
];

/** Loading state for the download trend chart. */
export function DownloadTrendSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading download activity"
      className="relative rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SkeletonBlock className="h-4 w-14" />
        <div className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
          <SkeletonBlock className="h-7 w-14" />
          <SkeletonBlock className="h-7 w-16" />
          <SkeletonBlock className="h-7 w-14" />
          <SkeletonBlock className="h-7 w-10" />
        </div>
      </div>
      <div className="relative aspect-[820/286] overflow-hidden">
        <div className="absolute inset-x-5 top-1/4 border-t border-dashed border-[var(--color-border)]" />
        <div className="absolute inset-x-5 top-1/2 border-t border-dashed border-[var(--color-border)]" />
        <div className="absolute inset-x-5 top-3/4 border-t border-dashed border-[var(--color-border)]" />
        <SkeletonBlock className="absolute bottom-8 left-5 right-5 h-1/2 rounded-lg opacity-60" />
      </div>
    </div>
  );
}

/** Renders download activity for a selected period. */
export function DownloadTrend({
  series,
  range,
  onRangeChange,
}: {
  series: DownloadSeriesPoint[];
  range: DownloadRange;
  onRangeChange: (range: DownloadRange) => void;
}) {
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const ordered = [...series].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const width = 820;
  const height = 286;
  const plot = { left: 44, right: 20, top: 24, bottom: 48 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const maximum = ordered.length > 0
    ? Math.max(...ordered.map((point) => point.downloads), 1)
    : 0;
  const points = ordered.map((point, index) => ({
    ...point,
    x: plot.left + (ordered.length === 1
      ? plotWidth / 2
      : (index / (ordered.length - 1)) * plotWidth),
    y: plot.top + plotHeight - (point.downloads / maximum) * plotHeight,
  }));
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");
  const areaPath = `${linePath} L ${points.at(-1)?.x ?? plot.left},${
    plot.top + plotHeight
  } L ${points[0]?.x ?? plot.left},${plot.top + plotHeight} Z`;
  const labelIndexes = ordered.length <= 5
    ? ordered.map((_, index) => index)
    : [0, Math.floor((ordered.length - 1) / 2), ordered.length - 1];
  const gridRatios = [0, 0.5, 1];
  const activePoint = points.find((point) => point.date === activeDate);

  return (
    <div>
      <div className="relative rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Period
          </span>
          <div
            className={[
              "flex flex-wrap gap-1 rounded-lg border",
              "border-[var(--color-border)] bg-[var(--color-surface)] p-1",
            ].join(" ")}
            role="group"
            aria-label="Download period"
          >
            {downloadRangeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={range === option.value}
                onClick={() => onRangeChange(option.value)}
                className={[
                  "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                  range === option.value
                    ? "bg-[var(--color-primary)] text-white shadow-sm"
                    : [
                        "text-[var(--color-text-muted)]",
                        "hover:bg-[var(--color-surface-muted)]",
                        "hover:text-[var(--color-text)]",
                      ].join(" "),
                ].join(" ")}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          <svg
            className="h-auto w-full"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-labelledby="download-chart-title download-chart-description"
          >
          <title id="download-chart-title">Downloads by day</title>
          <desc id="download-chart-description">
            Daily download events for the selected period.
          </desc>
          <defs>
            <linearGradient id="download-area-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.24" />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {gridRatios.map((ratio) => {
            const y = plot.top + plotHeight * ratio;
            return (
              <g key={ratio}>
                <line
                  x1={plot.left}
                  x2={width - plot.right}
                  y1={y}
                  y2={y}
                  stroke="var(--color-border)"
                  strokeDasharray="3 7"
                />
                {ordered.length > 0 && (
                  <text
                    x={plot.left - 10}
                    y={y + 4}
                    fill="var(--color-text-muted)"
                    fontSize="12"
                    textAnchor="end"
                  >
                    {formatStatisticsNumber(Math.round(maximum * (1 - ratio)))}
                  </text>
                )}
              </g>
            );
          })}
          <path d={areaPath} fill="url(#download-area-fill)" />
          <path
            d={linePath}
            fill="none"
            stroke="var(--color-primary)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
          />
          {points.map((point) => (
            <g
              key={point.date}
              tabIndex={0}
              role="img"
              aria-label={`${formatChartDate(point.date)}: ${formatStatisticsNumber(point.downloads)} downloads`}
              onMouseEnter={() => setActiveDate(point.date)}
              onMouseLeave={() => setActiveDate(null)}
              onFocus={() => setActiveDate(point.date)}
              onBlur={() => setActiveDate(null)}
            >
              <circle cx={point.x} cy={point.y} r="11" fill="transparent" />
              <circle
                cx={point.x}
                cy={point.y}
                r="5"
                fill="var(--color-surface)"
                stroke="var(--color-primary)"
                strokeWidth="3"
              >
                <title>
                  {`${formatChartDate(point.date)}: ${formatStatisticsNumber(point.downloads)} downloads`}
                </title>
              </circle>
            </g>
          ))}
          {labelIndexes.map((index) => {
            const point = points[index];
            if (!point) return null;
            return (
              <text
                key={point.date}
                x={point.x}
                y={height - 14}
                fill="var(--color-text-muted)"
                fontSize="12"
                textAnchor={index === 0
                  ? "start"
                  : index === points.length - 1
                    ? "end"
                    : "middle"}
              >
                {formatChartDate(point.date)}
              </text>
            );
          })}
          </svg>
          {activePoint && (
            <div
              className="pointer-events-none absolute"
              style={{
                left: `${(activePoint.x / width) * 100}%`,
                top: `${(activePoint.y / height) * 100}%`,
              }}
            >
              <ChartTooltip
                label={formatChartDate(activePoint.date)}
                value={`${formatStatisticsNumber(activePoint.downloads)} downloads`}
                className="-translate-x-1/2 -translate-y-[calc(100%+0.75rem)]"
              />
            </div>
          )}
        </div>
        {ordered.length === 0 && (
          <div className="pointer-events-none absolute inset-x-16 top-1/2 -translate-y-1/2 text-center">
            <p className="text-sm font-semibold">No activity yet</p>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              No download events are available for the selected period.
            </p>
          </div>
        )}
      </div>
      <table className="sr-only" aria-label="Download events by period">
        <caption>Download events by period</caption>
        <thead>
          <tr><th>Period</th><th>Downloads</th></tr>
        </thead>
        <tbody>
          {ordered.map((point) => (
            <tr key={point.date}>
              <th scope="row">{point.date}</th>
              <td>{formatStatisticsNumber(point.downloads)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
