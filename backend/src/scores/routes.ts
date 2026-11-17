import crypto from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthRequestContext, AuthService } from "../auth/service.js";
import { parseCookies } from "../auth/session.js";
import type { BackendConfig } from "../config/env.js";
import { encodePythonJson } from "../compatibility/serialization.js";
import { publicScoreError } from "./errors.js";
import type { ScoreListQuery, ScoresService } from "./service.js";

interface ScoreRouteOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly scores: ScoresService;
}

function sendJson(reply: FastifyReply, body: unknown, status?: number): FastifyReply {
  if (status !== undefined) reply.code(status);
  return reply.header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

function body(request: FastifyRequest): unknown { return request.body; }

function bearer(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim() || undefined;
  const legacy = request.headers["x-prg32-token"];
  return typeof legacy === "string" ? legacy.trim() || undefined : undefined;
}

function authContext(request: FastifyRequest, auth: AuthService): AuthRequestContext {
  return auth.context(parseCookies(request.headers.cookie).get("prg32_ts_session"), bearer(request));
}

function csrfHeader(request: FastifyRequest): string {
  const value = request.headers["x-csrftoken"] ?? request.headers["x-csrf-token"];
  if (typeof value === "string") return value.trim();
  if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {
    const candidate = (request.body as Record<string, unknown>).csrf_token;
    return typeof candidate === "string" ? candidate.trim() : "";
  }
  return "";
}

function hasValidCsrf(request: FastifyRequest, context: AuthRequestContext): boolean {
  const expected = context.session?.csrfToken;
  const provided = csrfHeader(request);
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  return expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes);
}

function requireBrowserCsrf(request: FastifyRequest, reply: FastifyReply, context: AuthRequestContext): boolean {
  if (!context.principal.authenticated || context.bearerOnly) return true;
  if (hasValidCsrf(request, context)) return true;
  sendJson(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
  return false;
}

function sourceKey(request: FastifyRequest): string {
  // Fastify trustProxy is not enabled. Do not use arbitrary X-Forwarded-For.
  return request.ip || "unknown";
}

function routeError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  request.log.warn({ err: error, requestId: request.id }, "score request rejected");
  const result = publicScoreError(error);
  if (result.retryAfter !== undefined) reply.header("retry-after", String(result.retryAfter));
  return sendJson(reply, result.body, result.statusCode);
}

export function registerScoreRoutes(app: FastifyInstance, options: ScoreRouteOptions): void {
  const { auth, config, scores } = options;

  app.get<{ Querystring: ScoreListQuery }>("/api/scores", async (request, reply) => {
    try {
      return sendJson(reply, scores.list(request.query));
    } catch (error) {
      return routeError(request, reply, error);
    }
  });

  app.route<{ Body: unknown }>({
    method: "POST",
    url: "/api/scores",
    bodyLimit: config.scoresMaxContentBytes,
    handler: async (request, reply) => {
      const context = authContext(request, auth);
      if (!requireBrowserCsrf(request, reply, context)) return reply;
      try {
        const submittedBy = context.principal.authenticated ? context.principal.name : "anonymous";
        return sendJson(reply, scores.create(body(request), sourceKey(request), submittedBy));
      } catch (error) {
        return routeError(request, reply, error);
      }
    }
  });
}

export function scoreRequestError(error: unknown): { statusCode: number; body: Record<string, unknown> } | null {
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return { statusCode: 413, body: { ok: false, error: "score payload is too large", code: "score_payload_too_large" } };
  if (code === "FST_ERR_CTP_INVALID_JSON_BODY") return { statusCode: 400, body: { ok: false, error: "invalid score JSON", code: "invalid_score_json" } };
  return null;
}
