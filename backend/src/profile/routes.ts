import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";

import type { AuthService } from "../auth/service.js";
import { parseCookies } from "../auth/session.js";
import { roleAtLeast } from "../auth/principal.js";
import { encodePythonJson } from "../compatibility/serialization.js";
import { summarizeSamples, type SampleRecord } from "../metrics/service.js";

type DatabaseSource = Database.Database | { get(): { sqlite: Database.Database } };

interface ProfileRouteOptions {
  readonly database: DatabaseSource;
  readonly auth: AuthService;
}

interface UserParams { readonly username: string; }
interface RunParams extends UserParams { readonly run_id: string; }
interface PageQuery { readonly page?: string; }

function sqlite(source: DatabaseSource): Database.Database {
  return "get" in source ? source.get().sqlite : source;
}

function sendJson(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

function principal(request: FastifyRequest, auth: AuthService) {
  const bearer = typeof request.headers.authorization === "string" && request.headers.authorization.toLowerCase().startsWith("bearer ")
    ? request.headers.authorization.slice(7).trim() || undefined
    : undefined;
  return auth.context(parseCookies(request.headers.cookie).get("prg32_ts_session"), bearer).principal;
}

function sampleRows(database: Database.Database, runId: string): SampleRecord[] {
  return database.prepare("SELECT frame, timestamp_ms, update_us, draw_us, present_us, frame_us, heap_free, heap_min_free, input_mask, fps_x100, upload_queue_depth, deadline_missed FROM samples WHERE run_id = ? ORDER BY frame ASC").all(runId) as SampleRecord[];
}

function page(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function registerProfileRoutes(app: FastifyInstance, options: ProfileRouteOptions): void {
  app.get<{ Params: UserParams }>("/api/users/:username", async (request, reply) => {
    const database = sqlite(options.database);
    const user = database.prepare("SELECT id, username, role, created_at FROM users WHERE username = ?").get(request.params.username) as { id: number; username: string; role: string; created_at: string } | undefined;
    if (!user) return sendJson(reply, { ok: false, error: "user not found", code: "user_not_found" }, 404);
    const runCount = Number((database.prepare("SELECT COUNT(*) AS count FROM runs WHERE user_id = ?").get(user.id) as { count: number }).count);
    const current = principal(request, options.auth);
    const canViewRuns = current.authenticated && (current.id === user.id || roleAtLeast(current.role, "admin"));
    return sendJson(reply, { ok: true, user: { username: user.username, role: user.role, created_at: user.created_at }, run_count: runCount, can_view_runs: canViewRuns });
  });

  app.get<{ Params: UserParams; Querystring: PageQuery }>("/api/users/:username/runs", async (request, reply) => {
    const database = sqlite(options.database);
    const user = database.prepare("SELECT id, username FROM users WHERE username = ?").get(request.params.username) as { id: number; username: string } | undefined;
    if (!user) return sendJson(reply, { ok: false, error: "user not found", code: "user_not_found" }, 404);
    const current = principal(request, options.auth);
    if (!current.authenticated || (current.id !== user.id && !roleAtLeast(current.role, "admin"))) return sendJson(reply, { ok: false, error: "forbidden", code: "forbidden" }, 403);
    const currentPage = page(request.query.page);
    const perPage = 25;
    const total = Number((database.prepare("SELECT COUNT(*) AS count FROM runs WHERE user_id = ?").get(user.id) as { count: number }).count);
    const rows = database.prepare("SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(user.id, perPage, (currentPage - 1) * perPage) as Array<Record<string, unknown>>;
    const runs = rows.map((run) => {
      const samples = sampleRows(database, String(run.run_id));
      const summary = summarizeSamples(samples);
      return { ...run, sample_count: summary.sample_count, mean_frame_us: summary.frame_us_avg, p95_frame_us: summary.frame_us_p95 };
    });
    const pages = Math.max(Math.ceil(total / perPage), 1);
    return sendJson(reply, { ok: true, user: { username: user.username }, runs, pagination: { page: Math.min(currentPage, pages), per_page: perPage, total, pages, has_next: currentPage < pages, has_prev: currentPage > 1 } });
  });

  app.get<{ Params: RunParams }>("/api/users/:username/runs/:run_id", async (request, reply) => {
    const database = sqlite(options.database);
    const user = database.prepare("SELECT id, username FROM users WHERE username = ?").get(request.params.username) as { id: number; username: string } | undefined;
    const run = database.prepare("SELECT * FROM runs WHERE run_id = ?").get(request.params.run_id) as Record<string, unknown> | undefined;
    if (!user || !run || Number(run.user_id) !== user.id) return sendJson(reply, { ok: false, error: "run not found", code: "run_not_found" }, 404);
    const current = principal(request, options.auth);
    if (!current.authenticated || (current.id !== user.id && !roleAtLeast(current.role, "admin"))) return sendJson(reply, { ok: false, error: "forbidden", code: "forbidden" }, 403);
    const summary = summarizeSamples(sampleRows(database, request.params.run_id));
    return sendJson(reply, { ok: true, user: { username: user.username }, run, summary });
  });
}
