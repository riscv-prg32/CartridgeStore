import crypto from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { encodePythonJson } from "../compatibility/serialization.js";
import type { FederationProviderOperations } from "./operations.js";

interface ProviderParams { readonly providerId: string }
interface IdentityParams { readonly identityId: string }
interface UserParams { readonly userId: string }

function json(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

function body(request: FastifyRequest): Record<string, unknown> {
  if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) throw new Error("invalid body");
  return request.body as Record<string, unknown>;
}

function numberParam(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("invalid identifier");
  return result;
}

function authorized(request: FastifyRequest, token: string | undefined): boolean {
  if (!token) return false;
  const received = request.headers["x-prg32-federation-lifecycle-token"];
  if (typeof received !== "string") return false;
  const expected = Buffer.from(token, "utf8");
  const actual = Buffer.from(received, "utf8");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function registerFederationLifecycleTestRoutes(app: FastifyInstance, options: { readonly token: string | undefined; readonly operations: FederationProviderOperations }): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/_test/federation/")) return;
    if (!authorized(request, options.token)) {
      await json(reply, { ok: false, error: "not found", code: "not_found" }, 404);
    }
  });

  app.get<{ Params: ProviderParams }>("/_test/federation/providers/:providerId", async (request, reply) => {
    if (reply.sent) return reply;
    try { return json(reply, { ok: true, provider: options.operations.status(request.params.providerId) }); }
    catch { return json(reply, { ok: false, error: "federation operation failed", code: "federation_operation_failed" }, 400); }
  });

  app.get<{ Params: ProviderParams }>("/_test/federation/providers/:providerId/identity-ids", async (request, reply) => {
    if (reply.sent) return reply;
    try { return json(reply, { ok: true, identityIds: options.operations.identityIds(request.params.providerId) }); }
    catch { return json(reply, { ok: false, error: "federation operation failed", code: "federation_operation_failed" }, 400); }
  });

  app.post<{ Params: ProviderParams }>("/_test/federation/providers/:providerId/state", async (request, reply) => {
    if (reply.sent) return reply;
    try {
      const value = body(request).enabled;
      if (typeof value !== "boolean") throw new Error("invalid state");
      return json(reply, { ok: true, provider: options.operations.setEnabled(request.params.providerId, value, { actorUserId: 0, requestId: request.id }) });
    } catch { return json(reply, { ok: false, error: "federation operation failed", code: "federation_operation_failed" }, 400); }
  });

  app.post<{ Params: ProviderParams }>("/_test/federation/providers/:providerId/revoke-pending", async (request, reply) => {
    if (reply.sent) return reply;
    try { return json(reply, { ok: true, ...options.operations.revokePending(request.params.providerId, { actorUserId: 0, requestId: request.id }) }); }
    catch { return json(reply, { ok: false, error: "federation operation failed", code: "federation_operation_failed" }, 400); }
  });

  app.post<{ Params: IdentityParams }>("/_test/federation/identities/:identityId/retire", async (request, reply) => {
    if (reply.sent) return reply;
    try {
      const provider = options.operations.retireIdentityLink(numberParam(request.params.identityId), { actorUserId: 0, actorRole: "admin", reauthenticatedAt: Date.now(), requestId: request.id });
      return json(reply, { ok: true, provider });
    } catch { return json(reply, { ok: false, error: "federation operation failed", code: "federation_operation_failed" }, 400); }
  });

  app.post<{ Params: UserParams }>("/_test/federation/users/:userId/state", async (request, reply) => {
    if (reply.sent) return reply;
    try {
      const value = body(request).disabled;
      if (typeof value !== "boolean") throw new Error("invalid state");
      options.operations.setLocalAccountDisabled(numberParam(request.params.userId), value, { actorUserId: 0, requestId: request.id });
      return json(reply, { ok: true });
    } catch { return json(reply, { ok: false, error: "federation operation failed", code: "federation_operation_failed" }, 400); }
  });
}
