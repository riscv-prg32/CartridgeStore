import { z } from "zod";

export const downloadSeriesPointSchema = z
  .object({
    date: z.string(),
    downloads: z.number().int().nonnegative(),
  })
  .passthrough();

export const downloadStatsSchema = z
  .object({
    series: z.array(downloadSeriesPointSchema),
    total: z.number().int().nonnegative(),
    top_games: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          downloads: z.number().int().nonnegative(),
          last_published: z.unknown(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const gameDownloadStatsSchema = z
  .object({
    id: z.string(),
    total: z.number().int().nonnegative(),
    architectures: z.array(
      z
        .object({
          architecture: z.string(),
          downloads: z.number().int().nonnegative(),
        })
        .passthrough(),
    ),
    series: z.array(downloadSeriesPointSchema),
  })
  .passthrough();

export const scoreRecordSchema = z
  .object({
    game: z.string(),
    player: z.string(),
    score: z.number().int().nonnegative(),
    created_at: z.number().int().nonnegative(),
    submitted_by: z.string(),
  })
  .passthrough();

export const scoresSchema = z.array(scoreRecordSchema);

export const scoreStatsSchema = z
  .object({ scores: z.array(scoreRecordSchema) })
  .passthrough();

export const runStatsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(),
    active_last_7_days: z.number().int().nonnegative(),
  })
  .passthrough();

export const metricsRunSchema = z
  .object({
    run_id: z.string(),
    board_id: z.string(),
    target: z.string(),
    display_backend: z.string(),
    firmware_version: z.string(),
    firmware_git_sha: z.string(),
    game_name: z.string(),
    sample_period_frames: z.number().int().nonnegative(),
    started_at: z.number().int().nonnegative(),
    finished_at: z.number().int().nonnegative().nullable(),
    dropped_samples: z.number().int().nonnegative(),
    created_at: z.number().int().nonnegative(),
    submitted_by: z.string(),
    user_id: z.number().int().nullable(),
    sample_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const metricsSummarySchema = z
  .object({
    sample_count: z.number().int().nonnegative(),
    frame_us_avg: z.number().nonnegative(),
    frame_us_median: z.number().nonnegative(),
    frame_us_p95: z.number().nonnegative(),
    frame_us_max: z.number().nonnegative(),
    update_us_avg: z.number().nonnegative(),
    draw_us_avg: z.number().nonnegative(),
    present_us_avg: z.number().nonnegative(),
    fps_avg: z.number().nonnegative(),
    deadline_missed: z.number().int().nonnegative(),
  })
  .passthrough();

export const metricsRunDetailSchema = z
  .object({
    ok: z.literal(true),
    run: metricsRunSchema,
    summary: metricsSummarySchema,
  })
  .passthrough();

export const userProfileResponseSchema = z
  .object({
    ok: z.literal(true),
    user: z
      .object({
        username: z.string(),
        role: z.string(),
        created_at: z.string(),
      })
      .passthrough(),
    run_count: z.number().int().nonnegative(),
    can_view_runs: z.boolean(),
  })
  .passthrough();

export const userRunsResponseSchema = z
  .object({
    ok: z.literal(true),
    user: z.object({ username: z.string() }).passthrough(),
    runs: z.array(
      metricsRunSchema.extend({
        mean_frame_us: z.number(),
        p95_frame_us: z.number(),
      }),
    ),
    pagination: z
      .object({
        page: z.number().int(),
        per_page: z.number().int(),
        total: z.number().int(),
        pages: z.number().int(),
        has_next: z.boolean(),
        has_prev: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export const userRunResponseSchema = z
  .object({
    ok: z.literal(true),
    user: z.object({ username: z.string() }).passthrough(),
    run: metricsRunSchema,
    summary: metricsSummarySchema,
  })
  .passthrough();
