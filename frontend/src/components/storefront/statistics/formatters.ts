const numberFormat = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
});

/** Formats a statistics value using the storefront locale. */
export function formatStatisticsNumber(value: number): string {
  return numberFormat.format(value);
}

/** Formats an ISO calendar date for chart labels. */
export function formatChartDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}
