import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { parseCookies } from "../auth/session.js";
import { principalToJson } from "../auth/principal.js";
import type { AuthService } from "../auth/service.js";
import type { AuthorizationService } from "../authorization/service.js";
import { permissionGuard } from "../authorization/guards.js";
import { encodePythonJson } from "../compatibility/serialization.js";
import { ReviewError, publicReviewError } from "../review/errors.js";
import type { BackendConfig } from "../config/env.js";
import type { CanonicalDraftService } from "./drafts.js";

interface Options { readonly auth: AuthService; readonly authorization: AuthorizationService; readonly config: BackendConfig; readonly drafts: CanonicalDraftService; }
interface Params { readonly draft_id: string; }

function send(reply: FastifyReply, body: unknown, status?: number): FastifyReply { if (status !== undefined) reply.code(status); return reply.header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8")); }
function body(request: FastifyRequest): Record<string, unknown> { return request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {}; }
function bearer(request: FastifyRequest): string | undefined { const value = request.headers.authorization; return typeof value === "string" && value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : undefined; }
function principal(request: FastifyRequest, options: Options) { return options.auth.context(parseCookies(request.headers.cookie).get("prg32_ts_session"), bearer(request)); }
function csrf(request: FastifyRequest): string { const value = request.headers["x-csrftoken"] ?? request.headers["x-csrf-token"]; return typeof value === "string" ? value.trim() : ""; }
function owner(request: FastifyRequest, reply: FastifyReply, options: Options, write = false): number | null {
  const current = principal(request, options);
  if (!current.principal.authenticated || current.principal.id === null) { send(reply, { ok: false, error: "login required", user: principalToJson(current.principal) }, 401); return null; }
  if (!permissionGuard(options.authorization, current.principal, "catalog:submit")) { send(reply, { ok: false, error: "catalog submission permission required", code: "permission_denied" }, 403); return null; }
  if (write && !current.bearerOnly && (!current.session || csrf(request) !== current.session.csrfToken)) { send(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403); return null; }
  return current.principal.id;
}
async function bundle(request: FastifyRequest, config: BackendConfig): Promise<Uint8Array> {
  const chunks: Buffer<ArrayBufferLike>[] = [];
  for await (const part of request.parts()) {
    if (part.type === "file" && part.fieldname === "bundle") {
      for await (const chunk of part.file) { const next: Buffer<ArrayBufferLike> = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array); if (chunks.reduce((sum, item) => sum + item.byteLength, 0) + next.byteLength > config.submissionMaxArchiveBytes) throw new ReviewError("bundle upload is too large", "review_invalid_request", 413); chunks.push(next); }
    }
  }
  if (!chunks.length) throw new ReviewError("bundle upload is required");
  return Buffer.concat(chunks);
}
function routeError(reply: FastifyReply, error: unknown): FastifyReply { const result = publicReviewError(error); return send(reply, result.body, result.statusCode); }

export function registerDraftRoutes(app: FastifyInstance, options: Options): void {
  app.get("/api/drafts", async (request, reply) => { const userId = owner(request, reply, options); if (userId === null) return reply; try { return send(reply, { ok: true, drafts: options.drafts.list(userId) }); } catch (error) { return routeError(reply, error); } });
  app.post("/api/drafts", async (request, reply) => { const userId = owner(request, reply, options, true); if (userId === null) return reply; try { return send(reply, { ok: true, draft: options.drafts.create(userId, body(request).metadata ?? {}) }, 201); } catch (error) { return routeError(reply, error); } });
  app.get<{ Params: Params }>("/api/drafts/:draft_id", async (request, reply) => { const userId = owner(request, reply, options); if (userId === null) return reply; try { return send(reply, { ok: true, draft: options.drafts.detail(userId, request.params.draft_id) }); } catch (error) { return routeError(reply, error); } });
  app.patch<{ Params: Params }>("/api/drafts/:draft_id", async (request, reply) => { const userId = owner(request, reply, options, true); if (userId === null) return reply; try { return send(reply, { ok: true, draft: options.drafts.update(userId, request.params.draft_id, body(request).metadata) }); } catch (error) { return routeError(reply, error); } });
  app.delete<{ Params: Params }>("/api/drafts/:draft_id", async (request, reply) => { const userId = owner(request, reply, options, true); if (userId === null) return reply; try { options.drafts.delete(userId, request.params.draft_id); return send(reply, { ok: true }); } catch (error) { return routeError(reply, error); } });
  app.post<{ Params: Params }>("/api/drafts/:draft_id/artifact", async (request, reply) => { const userId = owner(request, reply, options, true); if (userId === null) return reply; try { return send(reply, { ok: true, draft: options.drafts.attach(userId, request.params.draft_id, await bundle(request, options.config)) }); } catch (error) { return routeError(reply, error); } });
  app.post<{ Params: Params }>("/api/drafts/:draft_id/submit", async (request, reply) => { const userId = owner(request, reply, options, true); if (userId === null) return reply; try { return send(reply, options.drafts.submit(userId, request.params.draft_id)); } catch (error) { return routeError(reply, error); } });
  app.post<{ Params: { submission_id: string } }>("/api/submissions/:submission_id/resubmit", async (request, reply) => {
    const userId = owner(request, reply, options, true); if (userId === null) return reply;
    const id = Number(request.params.submission_id);
    if (!Number.isSafeInteger(id) || id <= 0) return send(reply, { ok: false, error: "submission id is invalid" }, 400);
    try { return send(reply, { ok: true, draft: options.drafts.create(userId, {}, id) }, 201); } catch (error) { return routeError(reply, error); }
  });
}
