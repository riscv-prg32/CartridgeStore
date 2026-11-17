import { beforeEach, describe, expect, test, vi } from "vitest";

import { getRunDetail, getRuns } from "./metrics";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("metrics API contracts", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("accepts bounded run summaries and preserves raw service units", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response([{ run_id: "run-1", board_id: "lab", target: "qemu", display_backend: "qemu_rgb", firmware_version: "1", firmware_git_sha: "abc", game_name: "pong", sample_period_frames: 1, started_at: 100, finished_at: 200, dropped_samples: 0, created_at: 100, submitted_by: "Ada", user_id: 1, sample_count: 4 }]));
    const runs = await getRuns();
    expect(runs[0]?.target).toBe("qemu");
    expect(runs[0]?.sample_count).toBe(4);

    vi.mocked(fetch).mockResolvedValue(response({ ok: true, run: runs[0], summary: { sample_count: 4, frame_us_avg: 30000, frame_us_median: 30000, frame_us_p95: 32000, frame_us_max: 33000, update_us_avg: 1000, draw_us_avg: 2000, present_us_avg: 27000, fps_avg: 33.33, deadline_missed: 0 } }));
    const detail = await getRunDetail("run-1");
    expect(detail.summary.frame_us_avg).toBe(30000);
    expect(detail.summary.fps_avg).toBe(33.33);
  });

  test("accepts an empty owner-scoped run list without inventing runs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response([]));
    await expect(getRuns()).resolves.toEqual([]);
  });
});
