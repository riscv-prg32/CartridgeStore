import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { parseCookies } from "../auth/session.js";
import type { AuthService } from "../auth/service.js";
import type { BackendConfig } from "../config/env.js";
import { encodePythonJson } from "../compatibility/serialization.js";
import { publicMetricsError } from "./errors.js";
import type { MetricsService } from "./service.js";
import { API_V1_BASE_PATH } from "../api/versioning.js";

interface MetricsRouteOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly metrics: MetricsService;
}

interface RunParams { readonly run_id: string; }
interface RunQuery { readonly format?: string; }

function sendJson(reply: FastifyReply, body: unknown, status?: number): FastifyReply {
  if (status !== undefined) reply.code(status);
  return reply.header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

function bearer(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim() || undefined;
  const legacy = request.headers["x-prg32-token"];
  return typeof legacy === "string" ? legacy.trim() || undefined : undefined;
}

function principal(request: FastifyRequest, auth: AuthService) {
  return auth.context(parseCookies(request.headers.cookie).get("prg32_ts_session"), bearer(request)).principal;
}

function body(request: FastifyRequest): unknown { return request.body; }

function routeError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  request.log.warn({ err: error, requestId: request.id }, "metrics request rejected");
  const result = publicMetricsError(error);
  return sendJson(reply, result.body, result.statusCode);
}

function safeFilename(runId: string): string {
  return runId.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortedJson(item)]));
  return value;
}

export function registerMetricsRoutes(app: FastifyInstance, options: MetricsRouteOptions): void {
  const { auth, config, metrics } = options;

  app.get("/api/metrics", async (request, reply) => {
    const originalUrl = (request.raw as typeof request.raw & { originalUrl?: string }).originalUrl ?? request.url;
    const prefix = originalUrl.split("?", 1)[0]?.startsWith(`${API_V1_BASE_PATH}/`) ? API_V1_BASE_PATH : "/api";
    return sendJson(reply, {
      ok: true,
      service: "PRG32 metrics",
      endpoints: [
        `POST ${prefix}/runs`,
        `POST ${prefix}/metrics/batch`,
        `POST ${prefix}/runs/<run_id>/finish`,
        `GET ${prefix}/runs`,
        `GET ${prefix}/runs/<run_id>`,
        `GET ${prefix}/runs/<run_id>/samples.csv`,
        `GET ${prefix}/runs/<run_id>/report.md`
      ]
    });
  });

  app.route<{ Body: unknown }>({ method: "POST", url: "/api/runs", bodyLimit: config.metricsMaxContentBytes, handler: async (request, reply) => {
    try { return sendJson(reply, metrics.createRun(body(request), principal(request, auth))); }
    catch (error) { return routeError(request, reply, error); }
  }});

  app.route<{ Body: unknown }>({ method: "POST", url: "/api/metrics/batch", bodyLimit: config.metricsMaxContentBytes, handler: async (request, reply) => {
    try { return sendJson(reply, metrics.createBatch(body(request))); }
    catch (error) { return routeError(request, reply, error); }
  }});

  app.route<{ Params: RunParams; Body: unknown }>({ method: "POST", url: "/api/runs/:run_id/finish", bodyLimit: config.metricsMaxContentBytes, handler: async (request, reply) => {
    try { return sendJson(reply, metrics.finishRun(request.params.run_id, body(request))); }
    catch (error) { return routeError(request, reply, error); }
  }});

  app.get("/api/runs", async (request, reply) => {
    try { return sendJson(reply, metrics.listRuns(principal(request, auth))); }
    catch (error) { return routeError(request, reply, error); }
  });

  app.get<{ Params: RunParams; Querystring: RunQuery }>("/api/runs/:run_id", async (request, reply) => {
    const current = principal(request, auth);
    try {
      if (request.query.format === "json") {
        const payload = metrics.jsonExport(request.params.run_id, current);
        return reply.header("content-type", "application/json").header("content-disposition", `attachment; filename=run-${safeFilename(request.params.run_id)}.json`).send(Buffer.from(`${JSON.stringify(sortedJson(payload), null, 2)}\n`, "utf8"));
      }
      return sendJson(reply, metrics.detail(request.params.run_id, current));
    } catch (error) { return routeError(request, reply, error); }
  });

  app.get<{ Params: RunParams }>("/api/runs/:run_id/samples.csv", async (request, reply) => {
    try { return reply.header("content-type", "text/csv; charset=utf-8").send(metrics.csvExport(request.params.run_id, principal(request, auth))); }
    catch (error) { return routeError(request, reply, error); }
  });

  app.get<{ Params: RunParams }>("/api/runs/:run_id/report.md", async (request, reply) => {
    try { return reply.header("content-type", "text/markdown; charset=utf-8").send(metrics.markdownExport(request.params.run_id, principal(request, auth))); }
    catch (error) { return routeError(request, reply, error); }
  });
}
