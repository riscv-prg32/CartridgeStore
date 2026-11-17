import crypto from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthorizationService } from "../authorization/service.js";
import { encodePythonJson } from "../compatibility/serialization.js";
import type { BackendConfig } from "../config/env.js";
import type { AuthRequestContext, AuthService } from "./service.js";
import { parseCookies, serializeSessionCookie } from "./session.js";
import { principalToJson, type Principal } from "./principal.js";
import { PERMISSIONS } from "../authorization/permissions.js";
import { permissionGuard } from "../authorization/guards.js";
import { WebAuthnError, type WebAuthnService } from "./webauthn.js";

const SESSION_COOKIE = "prg32_ts_session";
type Body = Record<string, unknown>;
interface CredentialParams { readonly credential_id: string }
interface AdminCredentialParams { readonly userId: string; readonly credential_id: string }

function json(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}
function body(request: FastifyRequest): Body {
  return request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Body : {};
}
function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim() || undefined;
  const legacy = request.headers["x-prg32-token"];
  return typeof legacy === "string" ? legacy.trim() || undefined : undefined;
}
function context(request: FastifyRequest, auth: AuthService): AuthRequestContext {
  return auth.context(parseCookies(request.headers.cookie).get(SESSION_COOKIE), bearer(request));
}
function csrf(request: FastifyRequest): string {
  const value = request.headers["x-csrftoken"] ?? request.headers["x-csrf-token"];
  return typeof value === "string" ? value.trim() : "";
}
function same(value: string, expected: string): boolean {
  const left = Buffer.from(value); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function setSessionCookie(reply: FastifyReply, config: BackendConfig, auth: AuthService, value: string, expires = false): void {
  reply.header("set-cookie", serializeSessionCookie({ name: SESSION_COOKIE, secure: config.authCookieSecure, sameSite: config.authCookieSameSite, domain: config.authCookieDomain, maxAgeSeconds: auth.sessionLifetimeSeconds() }, value, expires));
}
function principalJson(authorization: AuthorizationService, principal: Principal): Record<string, unknown> {
  return { ...principalToJson(principal), permissions: principal.authenticated ? PERMISSIONS.filter((permission) => permissionGuard(authorization, principal, permission)) : [] };
}
function requireCsrf(current: AuthRequestContext, request: FastifyRequest, reply: FastifyReply): boolean {
  if (current.bearerOnly || !current.session || !csrf(request) || !same(current.session.csrfToken, csrf(request))) { json(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403); return false; }
  return true;
}

export interface WebAuthnRouteOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly authorization: AuthorizationService;
  readonly webauthn: WebAuthnService | null;
}

export function registerWebAuthnRoutes(app: FastifyInstance, options: WebAuthnRouteOptions): void {
  const paths = (path: string): string[] => [path, `/api${path}`];
  const service = options.webauthn;
  const handle = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof WebAuthnError) return json(reply, { ok: false, error: error.message, code: error.code }, error.statusCode);
    return json(reply, { ok: false, error: "passkey operation failed", code: "webauthn_operation_failed" }, 500);
  };
  if (!service) return;

  for (const path of paths("/auth/passkeys")) app.get(path, async (request, reply) => {
    const current = context(request, options.auth);
    if (!current.principal.authenticated || current.principal.id === null) return json(reply, { ok: false, error: "login required", code: "auth_required" }, 401);
    try { return json(reply, { ok: true, credentials: service.list(current.principal.id) }); } catch (error) { return handle(reply, error); }
  });

  for (const path of paths("/auth/passkeys/register/options")) app.post<{ Body: Body }>(path, async (request, reply) => {
    const current = context(request, options.auth);
    if (!current.principal.authenticated || current.principal.id === null) return json(reply, { ok: false, error: "login required", code: "auth_required" }, 401);
    if (!requireCsrf(current, request, reply)) return reply;
    try { return json(reply, { ok: true, options: await service.beginRegistration(current.principal.id, current.session) }); } catch (error) { return handle(reply, error); }
  });

  for (const path of paths("/auth/passkeys/register")) app.post<{ Body: Body }>(path, async (request, reply) => {
    const current = context(request, options.auth);
    if (!current.principal.authenticated || current.principal.id === null) return json(reply, { ok: false, error: "login required", code: "auth_required" }, 401);
    if (!requireCsrf(current, request, reply)) return reply;
    try { return json(reply, await service.finishRegistration(current.principal.id, current.session, body(request).response, body(request).display_name), 201); } catch (error) { return handle(reply, error); }
  });

  for (const path of paths("/auth/passkeys/login/options")) app.post<{ Body: Body }>(path, async (request, reply) => {
    let current = context(request, options.auth);
    if (!requireCsrf(current, request, reply)) {
      if (!current.session && !request.headers.cookie) {
        const issued = options.auth.issueAnonymousSession();
        setSessionCookie(reply, options.config, options.auth, issued.cookieValue);
      }
      return reply;
    }
    try {
      if (!current.session) {
        const issued = options.auth.issueAnonymousSession();
        setSessionCookie(reply, options.config, options.auth, issued.cookieValue);
        current = { ...current, session: issued.record };
      }
      return json(reply, { ok: true, options: await service.beginAuthentication(body(request).username, current.session) });
    } catch (error) { return handle(reply, error); }
  });

  for (const path of paths("/auth/passkeys/login")) app.post<{ Body: Body }>(path, async (request, reply) => {
    const current = context(request, options.auth);
    if (!requireCsrf(current, request, reply)) return reply;
    try {
      const result = await service.finishAuthentication(current.session, body(request).response);
      setSessionCookie(reply, options.config, options.auth, result.sessionCookie);
      const principal = options.auth.context(result.sessionCookie, undefined).principal;
      return json(reply, { ok: true, user: principalJson(options.authorization, principal) });
    } catch (error) { return handle(reply, error); }
  });

  for (const path of paths("/auth/passkeys/:credential_id")) app.patch<{ Params: CredentialParams; Body: Body }>(path, async (request, reply) => {
    const current = context(request, options.auth);
    if (!current.principal.authenticated || current.principal.id === null) return json(reply, { ok: false, error: "login required", code: "auth_required" }, 401);
    if (!requireCsrf(current, request, reply)) return reply;
    try { return json(reply, service.rename(current.principal.id, request.params.credential_id, current.session, body(request).display_name)); } catch (error) { return handle(reply, error); }
  });

  for (const path of paths("/auth/passkeys/:credential_id")) app.delete<{ Params: CredentialParams }>(path, async (request, reply) => {
    const current = context(request, options.auth);
    if (!current.principal.authenticated || current.principal.id === null) return json(reply, { ok: false, error: "login required", code: "auth_required" }, 401);
    if (!requireCsrf(current, request, reply)) return reply;
    try { return json(reply, service.revoke(current.principal.id, request.params.credential_id, current.session)); } catch (error) { return handle(reply, error); }
  });

  app.delete<{ Params: AdminCredentialParams }>("/api/admin/users/:userId/passkeys/:credential_id", async (request, reply) => {
    const current = context(request, options.auth);
    if (!current.principal.authenticated || current.principal.id === null) return json(reply, { ok: false, error: "login required", code: "auth_required" }, 401);
    if (!permissionGuard(options.authorization, current.principal, "users:update")) return json(reply, { ok: false, error: "administrator privileges required", code: "admin_required" }, 403);
    if (!requireCsrf(current, request, reply)) return reply;
    if (!/^\d+$/u.test(request.params.userId)) return json(reply, { ok: false, error: "user_id is invalid", code: "invalid_identifier" }, 400);
    try { return json(reply, service.revokeByAdministrator(current.principal.id, Number(request.params.userId), request.params.credential_id, current.session)); } catch (error) { return handle(reply, error); }
  });
}
