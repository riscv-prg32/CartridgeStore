import crypto from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { encodePythonJson } from "../compatibility/serialization.js";
import type { BackendConfig } from "../config/env.js";
import { parseCookies, serializeSessionCookie } from "../auth/session.js";
import { SetupError, SetupService } from "./service.js";
import { BoundedRateLimiter } from "../security/rate-limiter.js";

interface SetupRouteOptions {
  readonly config: BackendConfig;
  readonly setup: SetupService;
}

interface Body { readonly [key: string]: unknown }

function json(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

function body(request: FastifyRequest): Body {
  if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) return request.body as Body;
  return {};
}

function requestId(request: FastifyRequest): string { return request.id; }

function constantTimeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function csrfHeader(request: FastifyRequest): string {
  const value = request.headers["x-csrftoken"] ?? request.headers["x-csrf-token"];
  return typeof value === "string" ? value.trim() : "";
}

function setupSession(request: FastifyRequest, setup: SetupService) {
  return setup.session(parseCookies(request.headers.cookie).get(SetupService.cookieName()));
}

function sameOrigin(request: FastifyRequest, config: BackendConfig): boolean {
  const expected = config.frontendPublicOrigin;
  if (!expected) return true;
  const supplied = request.headers.origin;
  if (typeof supplied === "string" && supplied.length > 0) return supplied === expected;
  const referer = request.headers.referer;
  if (typeof referer === "string" && referer.length > 0) {
    try { return new URL(referer).origin === expected; } catch { return false; }
  }
  return true;
}

function setSetupCookie(reply: FastifyReply, config: BackendConfig, value: string, expires = false): void {
  reply.header("set-cookie", serializeSessionCookie({
    name: SetupService.cookieName(),
    secure: config.authCookieSecure,
    sameSite: config.authCookieSameSite,
    domain: config.authCookieDomain,
    maxAgeSeconds: SetupService.sessionLifetimeSeconds()
  }, value, expires));
}

function errorResponse(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply {
  if (error instanceof SetupError) {
    request.log.warn({ code: error.code, requestId: request.id }, "setup operation rejected");
    return json(reply, { ok: false, error: error.message, code: error.code }, error.statusCode);
  }
  request.log.error({ code: "setup_internal_error", requestId: request.id }, "setup operation failed");
  return json(reply, { ok: false, error: "installation operation failed", code: "setup_operation_failed" }, 500);
}

export function registerSetupRoutes(app: FastifyInstance, options: SetupRouteOptions): void {
  const authorizationLimiter = new BoundedRateLimiter(
    options.config.authRateLimitMax,
    options.config.authRateLimitWindowSeconds,
    options.config.authRateLimitMaxClients
  );

  app.get("/api/setup/status", async (_request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      return json(reply, options.setup.status());
    } catch (error) { return errorResponse(reply, _request, error); }
  });

  app.post<{ Body: Body }>("/api/setup/authorize", async (request, reply) => {
    if (!sameOrigin(request, options.config)) return json(reply, { ok: false, error: "origin is not allowed", code: "setup_origin_denied" }, 403);
    if (!authorizationLimiter.allow(request.ip || "unknown")) return json(reply, { ok: false, error: "too many requests", code: "rate_limited" }, 429);
    try {
      const input = body(request);
      const token = typeof input.bootstrap_token === "string" ? input.bootstrap_token.trim() : "";
      const result = options.setup.authorize(token);
      setSetupCookie(reply, options.config, result.session.id);
      reply.header("cache-control", "no-store");
      return json(reply, { ...result.progress, authorized: true });
    } catch (error) { return errorResponse(reply, request, error); }
  });

  app.get("/api/setup/progress", async (request, reply) => {
    try {
      const session = setupSession(request, options.setup);
      options.setup.requireSession(session);
      reply.header("cache-control", "no-store");
      return json(reply, options.setup.progress(session));
    } catch (error) { return errorResponse(reply, request, error); }
  });

  app.post<{ Body: Body }>("/api/setup/progress", async (request, reply) => {
    if (!sameOrigin(request, options.config)) return json(reply, { ok: false, error: "origin is not allowed", code: "setup_origin_denied" }, 403);
    try {
      const session = setupSession(request, options.setup);
      options.setup.requireSession(session);
      if (!constantTimeEqual(session.csrfToken, csrfHeader(request))) return json(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
      const input = body(request);
      const result = await options.setup.saveStep(session, input.step, input.payload ?? {}, requestId(request));
      reply.header("cache-control", "no-store");
      return json(reply, result);
    } catch (error) { return errorResponse(reply, request, error); }
  });

  app.post<{ Body: Body }>("/api/setup/smtp/test-connection", async (request, reply) => {
    if (!sameOrigin(request, options.config)) return json(reply, { ok: false, error: "origin is not allowed", code: "setup_origin_denied" }, 403);
    try {
      const session = setupSession(request, options.setup);
      options.setup.requireSession(session);
      if (!constantTimeEqual(session.csrfToken, csrfHeader(request))) return json(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
      return json(reply, await options.setup.testSmtpConnection(session));
    } catch (error) { return errorResponse(reply, request, error); }
  });

  app.post<{ Body: Body }>("/api/setup/smtp/test-message", async (request, reply) => {
    if (!sameOrigin(request, options.config)) return json(reply, { ok: false, error: "origin is not allowed", code: "setup_origin_denied" }, 403);
    try {
      const session = setupSession(request, options.setup);
      options.setup.requireSession(session);
      if (!constantTimeEqual(session.csrfToken, csrfHeader(request))) return json(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
      const recipient = typeof body(request).to === "string" ? body(request).to as string : "";
      return json(reply, await options.setup.sendSmtpTest(session, recipient));
    } catch (error) { return errorResponse(reply, request, error); }
  });

  app.post<{ Body: Body }>("/api/setup/federation/oidc/validate", async (request, reply) => {
    if (!sameOrigin(request, options.config)) return json(reply, { ok: false, error: "origin is not allowed", code: "setup_origin_denied" }, 403);
    try {
      const session = setupSession(request, options.setup);
      options.setup.requireSession(session);
      if (!constantTimeEqual(session.csrfToken, csrfHeader(request))) return json(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
      const issuer = typeof body(request).issuer === "string" ? body(request).issuer as string : "";
      return json(reply, await options.setup.validateOidc(session, issuer));
    } catch (error) { return errorResponse(reply, request, error); }
  });

  app.post<{ Body: Body }>("/api/setup/federation/saml/metadata", async (request, reply) => {
    if (!sameOrigin(request, options.config)) return json(reply, { ok: false, error: "origin is not allowed", code: "setup_origin_denied" }, 403);
    try {
      const session = setupSession(request, options.setup);
      options.setup.requireSession(session);
      if (!constantTimeEqual(session.csrfToken, csrfHeader(request))) return json(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
      const input = body(request);
      return json(reply, await options.setup.importSamlMetadata(session, { ...(typeof input.url === "string" ? { url: input.url } : {}), ...(typeof input.xml === "string" ? { xml: input.xml } : {}) }));
    } catch (error) { return errorResponse(reply, request, error); }
  });

  app.post("/api/setup/complete", async (request, reply) => {
    if (!sameOrigin(request, options.config)) return json(reply, { ok: false, error: "origin is not allowed", code: "setup_origin_denied" }, 403);
    try {
      const session = setupSession(request, options.setup);
      options.setup.requireSession(session);
      if (!constantTimeEqual(session.csrfToken, csrfHeader(request))) return json(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
      const result = options.setup.complete(session, requestId(request));
      setSetupCookie(reply, options.config, "", true);
      reply.header("cache-control", "no-store");
      return json(reply, result);
    } catch (error) { return errorResponse(reply, request, error); }
  });
}
