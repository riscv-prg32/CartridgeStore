export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export function formatBundleBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function validateBundleFile(candidate: File): string | null {
  if (!candidate.name.toLowerCase().endsWith(".zip")) return "Select a .zip cartridge bundle.";
  if (candidate.size > MAX_BUNDLE_BYTES) return `The bundle exceeds the client limit of ${formatBundleBytes(MAX_BUNDLE_BYTES)}.`;
  return null;
}
