export function formatScoreDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown time";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp * 1000));
}

export function formatRunDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown time";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp * 1000));
}
