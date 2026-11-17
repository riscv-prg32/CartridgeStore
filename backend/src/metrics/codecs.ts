import type { Principal } from "../auth/principal.js";
import type { AuthorizationService } from "../authorization/service.js";
import { MetricsError } from "./errors.js";
import type {
  MetricsSummary,
  RunRecord,
  SampleRecord,
} from "./contracts.js";

function fail(
  message: string,
  code: ConstructorParameters<typeof MetricsError>[1],
  statusCode = 400,
): never {
  throw new MetricsError(message, code, statusCode);
}

/** Converts scalar JSON values to the bounded text representation in storage. */
export function scalar(value: unknown, fallback = ""): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  return fallback;
}

/** Reads and bounds a text field from a metrics request. */
export function cleanText(
  payload: Record<string, unknown>,
  key: string,
  maxLength: number,
  fallback = "",
): string {
  return scalar(payload[key], fallback).trim().slice(0, maxLength);
}

/** Normalizes numeric metrics fields without changing the legacy coercion rules. */
export function intValue(
  value: unknown,
  fallback = 0,
  minimum = 0,
): number {
  if (value === null || value === undefined || value === "") {
    return Math.max(fallback, minimum);
  }

  const numeric =
    typeof value === "boolean"
      ? value
        ? 1
        : 0
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
  if (!Number.isFinite(numeric)) return Math.max(fallback, minimum);
  return Math.max(Math.trunc(numeric), minimum);
}

/** Validates the object boundary of a metrics request. */
export function recordBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid metrics payload", "invalid_metrics_payload");
  }

  return value as Record<string, unknown>;
}

/** Adapts a SQLite row to the public run contract. */
export function rowAsRun(row: Record<string, unknown>): RunRecord {
  return row as unknown as RunRecord;
}

/** Adapts a SQLite row to the public sample contract. */
export function rowAsSample(row: Record<string, unknown>): SampleRecord {
  return row as unknown as SampleRecord;
}

/** Checks whether a principal may read a run and its samples. */
export function ownerCanView(
  run: RunRecord,
  principal: Principal,
  authorization: AuthorizationService,
): boolean {
  if (run.user_id === null) {
    return authorization.hasPermission(principal, "runs:read:any");
  }

  return (
    authorization.canAccessResource(principal, "runs:read:self", {
      ownerId: run.user_id,
    }) || authorization.hasPermission(principal, "runs:read:any")
  );
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : ordered[middle] ?? 0;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 1) return ordered[0] ?? 0;
  const position = (ordered.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.min(low + 1, ordered.length - 1);
  const fraction = position - low;
  return (
    (ordered[low] ?? 0) * (1 - fraction) +
    (ordered[high] ?? 0) * fraction
  );
}

/** Calculates the stable aggregate metrics exposed by the service. */
export function summarizeSamples(
  samples: readonly SampleRecord[],
): MetricsSummary {
  const frameTimes = samples.map((sample) => sample.frame_us);
  const updateTimes = samples.map((sample) => sample.update_us);
  const drawTimes = samples.map((sample) => sample.draw_us);
  const presentTimes = samples.map((sample) => sample.present_us);
  const fpsValues = samples.map((sample) => sample.fps_x100 / 100);
  return {
    sample_count: samples.length,
    frame_us_avg: average(frameTimes),
    frame_us_median: median(frameTimes),
    frame_us_p95: quantile(frameTimes, 0.95),
    frame_us_max: frameTimes.length === 0 ? 0 : Math.max(...frameTimes),
    update_us_avg: average(updateTimes),
    draw_us_avg: average(drawTimes),
    present_us_avg: average(presentTimes),
    fps_avg: average(fpsValues),
    deadline_missed: samples.reduce(
      (count, sample) => count + (sample.deadline_missed ? 1 : 0),
      0,
    ),
  };
}

/** Formats a report value with one decimal place. */
export function formatOne(value: number): string {
  return value.toFixed(1);
}

/** Formats a report value with two decimal places. */
export function formatTwo(value: number): string {
  return value.toFixed(2);
}
