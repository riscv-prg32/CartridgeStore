import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

describe("minimal backend runtime", () => {
  it("serves liveness without opening a database", async () => {
    const app = buildApp({
      config: loadConfig({ PRG32_BACKEND_DB: "/does/not/exist/store.sqlite" }),
      logger: false
    });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      service: "prg32-cartridge-store-backend",
      status: "healthy"
    });
    await app.close();
  });

  it("reports readiness without exposing the configured database path", async () => {
    const app = buildApp({
      config: loadConfig({ PRG32_BACKEND_DB: "/does/not/exist/store.sqlite" }),
      logger: false
    });
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      status: "not_ready",
      resources: { database: "unavailable" }
    });
    expect(response.body).not.toContain("/does/not/exist");
    await app.close();
  });

  it("returns a stable error envelope for unhandled route failures", async () => {
    const app = buildApp({
      config: loadConfig({ PRG32_BACKEND_DB: "/does/not/exist/store.sqlite" }),
      logger: false
    });
    app.get("/test-error", () => {
      throw new Error("private implementation detail");
    });
    const response = await app.inject({ method: "GET", url: "/test-error" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "internal server error",
      code: "internal_error"
    });
    expect(response.body).not.toContain("private implementation detail");
    await app.close();
  });

  it("registers firmware ingestion endpoints but keeps them non-writable without the writer gate", async () => {
    const app = buildApp({
      config: loadConfig({ PRG32_BACKEND_DB: "/does/not/exist/store.sqlite" }),
      logger: false
    });
    await app.ready();
    expect(app.hasRoute({ method: "POST", url: "/api/scores" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/runs" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/metrics/batch" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/runs/:run_id/finish" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/multiplayer/status" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/multiplayer" })).toBe(true);

    const score = await app.inject({
      method: "POST",
      url: "/api/scores",
      payload: { game: "read-only", player: "fixture", score: 1 }
    });
    const run = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { run_id: "read-only", board_id: "fixture", target: "qemu" }
    });
    const batch = await app.inject({
      method: "POST",
      url: "/api/metrics/batch",
      payload: { run_id: "read-only", samples: [] }
    });
    const finish = await app.inject({
      method: "POST",
      url: "/api/runs/read-only/finish",
      payload: {}
    });

    expect(score.statusCode).toBe(503);
    expect(score.json()).toMatchObject({ code: "scores_unavailable" });
    expect(run.statusCode).toBe(503);
    expect(run.json()).toMatchObject({ code: "metrics_unavailable" });
    expect(batch.statusCode).toBe(503);
    expect(batch.json()).toMatchObject({ code: "metrics_unavailable" });
    expect(finish.statusCode).toBe(503);
    expect(finish.json()).toMatchObject({ code: "metrics_unavailable" });
    await app.close();
  });
});
