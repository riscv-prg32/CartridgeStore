import type Database from "better-sqlite3";

import type { AuthorizationService } from "../authorization/service.js";
import type { BackendConfig } from "../config/env.js";
import type { RuntimePolicy } from "../settings/runtime-policy.js";

/** Database provider used by the legacy and canonical metrics boundaries. */
export type DatabaseSource = Database.Database | (() => Database.Database);

/** Public run record returned by metrics and profile endpoints. */
export interface RunRecord {
  readonly run_id: string;
  readonly board_id: string;
  readonly target: string;
  readonly display_backend: string;
  readonly firmware_version: string;
  readonly firmware_git_sha: string;
  readonly game_name: string;
  readonly sample_period_frames: number;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly dropped_samples: number;
  readonly created_at: number;
  readonly submitted_by: string;
  readonly user_id: number | null;
  readonly sample_count?: number;
}

/** Public sample record returned by metrics exports. */
export interface SampleRecord {
  readonly frame: number;
  readonly timestamp_ms: number;
  readonly update_us: number;
  readonly draw_us: number;
  readonly present_us: number;
  readonly frame_us: number;
  readonly heap_free: number;
  readonly heap_min_free: number;
  readonly input_mask: number;
  readonly fps_x100: number;
  readonly upload_queue_depth: number;
  readonly deadline_missed: number;
}

/** Aggregate values used by JSON and Markdown metrics reports. */
export interface MetricsSummary {
  readonly sample_count: number;
  readonly frame_us_avg: number;
  readonly frame_us_median: number;
  readonly frame_us_p95: number;
  readonly frame_us_max: number;
  readonly update_us_avg: number;
  readonly draw_us_avg: number;
  readonly present_us_avg: number;
  readonly fps_avg: number;
  readonly deadline_missed: number;
}

/** Dependencies and feature gates required by the metrics service. */
export interface MetricsServiceOptions {
  readonly config: BackendConfig;
  readonly database: DatabaseSource;
  readonly writeEnabled: boolean;
  readonly canonicalMode?: boolean;
  readonly authorization?: AuthorizationService;
  readonly fault?: (point: "after-batch-sample" | "before-batch-commit") => void;
  readonly policy?: RuntimePolicy;
}
