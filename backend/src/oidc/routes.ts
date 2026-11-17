import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { encodePythonJson } from "../compatibility/serialization.js";
import type { BackendConfig } from "../config/env.js";
import { parseCookies, serializeSessionCookie } from "../auth/session.js";
import { browserReturnLocation } from "../auth/browser-redirect.js";
import { clearCorrelationCookie, OIDC_CORRELATION_COOKIE, serializeCorrelationCookie } from "./correlation.js";
import { OidcError, type OidcService } from "./service.js";

const SESSION_COOKIE = "prg32_ts_session";

interface ProviderParams { readonly providerId: string }

interface OidcRouteOptions {
  readonly config: BackendConfig;
  readonly oidc: OidcService;
  readonly sessionLifetimeSeconds: () => number;
}

function json(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "application/json").send(Buffer.from(encodePythonJson(body) + "\n", "utf8"));
}

function requestIp(request: FastifyRequest): string {
  return request.ip || "unknown";
}

function query(request: FastifyRequest): URLSearchParams {
  if (request.url.length > 2048) throw new OidcError("oidc_query_too_large", 400, "OIDC request is invalid");
  return new URL(request.url, "http://oidc.invalid").searchParams;
}

function operationFailure(reply: FastifyReply, request: FastifyRequest, error: unknown, config: BackendConfig, clear = false): FastifyReply {
  if (clear) reply.header("set-cookie", clearCorrelationCookie(config));
  if (error instanceof OidcError) {
    request.log.warn({ code: error.code, requestId: request.id }, "OIDC request rejected");
    return json(reply, { ok: false, error: error.message, code: error.code, ...(error.details ?? {}) }, error.statusCode);
  }
  request.log.warn({ code: "oidc_internal_error", requestId: request.id }, "OIDC request rejected");
  return json(reply, { ok: false, error: "OIDC authentication is unavailable", code: "oidc_unavailable" }, 503);
}

function setCookies(reply: FastifyReply, values: readonly string[]): void {
  reply.header("set-cookie", values);
}

export function registerOidcRoutes(app: FastifyInstance, options: OidcRouteOptions): void {
  app.get("/api/auth/providers", async (_request, reply) => json(reply, { ok: true, providers: options.oidc.publicProviders() }));

  const login = async (request: FastifyRequest, reply: FastifyReply, providerId: string): Promise<FastifyReply> => {
    try {
      const params = query(request);
      for (const key of params.keys()) if (key !== "return_to") throw new OidcError("oidc_unknown_parameter", 400, "OIDC request contains an unknown parameter");
      const result = await options.oidc.start(providerId, params.get("return_to"), { requestId: request.id, ip: requestIp(request) });
      reply.header("cache-control", "no-store");
      setCookies(reply, [serializeCorrelationCookie(options.config, result.correlationCookie)]);
      return reply.redirect(result.location);
    } catch (error) { return operationFailure(reply, request, error, options.config); }
  };

  const callback = async (request: FastifyRequest, reply: FastifyReply, providerId: string): Promise<FastifyReply> => {
    try {
      const cookies = parseCookies(request.headers.cookie);
      const result = await options.oidc.complete(providerId, request.url, cookies.get(OIDC_CORRELATION_COOKIE), cookies.get(SESSION_COOKIE), { requestId: request.id, ip: requestIp(request) });
      const sessionCookie = serializeSessionCookie({ name: SESSION_COOKIE, secure: options.config.authCookieSecure, sameSite: options.config.authCookieSameSite, domain: options.config.authCookieDomain, maxAgeSeconds: options.sessionLifetimeSeconds() }, result.sessionCookie);
      setCookies(reply, [sessionCookie, clearCorrelationCookie(options.config)]);
      reply.header("cache-control", "no-store");
      return reply.redirect(browserReturnLocation(options.config, result.returnPath));
    } catch (error) {
      setCookies(reply, [clearCorrelationCookie(options.config)]);
      return operationFailure(reply, request, error, options.config, true);
    }
  };

  app.get<{ Params: ProviderParams }>("/api/auth/oidc/:providerId/login", async (request, reply) => login(request, reply, request.params.providerId));
  app.get<{ Params: ProviderParams }>("/api/auth/oidc/:providerId/callback", async (request, reply) => callback(request, reply, request.params.providerId));
}
