import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { parseCookies } from "../auth/session.js";
import { principalToJson, type Principal } from "../auth/principal.js";
import type { AuthService } from "../auth/service.js";
import type { BackendConfig } from "../config/env.js";
import type { AuthorizationService } from "../authorization/service.js";
import { permissionGuard } from "../authorization/guards.js";
import { encodePythonJson } from "../compatibility/serialization.js";
import { publicReviewError, ReviewError } from "./errors.js";
import type { ReviewWorkflowService, SubmissionRecord } from "./service.js";

interface ReviewRouteOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly authorization: AuthorizationService;
  readonly review: ReviewWorkflowService | null;
}

interface SubmissionParams { readonly submission_id: string; }
interface SubmissionQuery { readonly status?: string; }
interface OwnedSubmissionQuery { readonly status?: string; readonly page?: string; readonly per_page?: string; }

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

function context(request: FastifyRequest, auth: AuthService) {
  return auth.context(parseCookies(request.headers.cookie).get("prg32_ts_session"), bearer(request));
}

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body === undefined || body === null || body === "") return {};
  if (typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  throw new ReviewError("request body must be an object");
}

function csrf(request: FastifyRequest, supplied: string | undefined): string {
  const header = request.headers["x-csrftoken"] ?? request.headers["x-csrf-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return supplied?.trim() ?? "";
}

function authorized(request: FastifyRequest, reply: FastifyReply, options: ReviewRouteOptions, permission: "submissions:read" | "submissions:review" | "submissions:reject", write: boolean, suppliedCsrf?: string): Principal | null {
  const authContext = context(request, options.auth);
  if (!authContext.principal.authenticated) {
    sendJson(reply, { ok: false, error: "login required", user: principalToJson(authContext.principal) }, 401);
    return null;
  }
  if (!permissionGuard(options.authorization, authContext.principal, permission)) {
    sendJson(reply, { ok: false, error: "editors group required", user: principalToJson(authContext.principal) }, 403);
    return null;
  }
  if (write && !authContext.bearerOnly && (!authContext.session || csrf(request, suppliedCsrf) !== authContext.session.csrfToken)) {
    sendJson(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
    return null;
  }
  return authContext.principal;
}

function id(request: FastifyRequest<{ Params: SubmissionParams }>): number {
  const value = Number(request.params.submission_id);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ReviewError("submission id is invalid");
  return value;
}

function queryInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new ReviewError("pagination value is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ReviewError("pagination value is invalid");
  return parsed;
}

function metadataFromJson(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata = payload.metadata;
  if (metadata === undefined) return {};
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) throw new ReviewError("metadata must be an object");
  return metadata as Record<string, unknown>;
}

function noteFromJson(payload: Record<string, unknown>): string {
  const note = payload.note;
  if (note === undefined || note === null) return "";
  if (typeof note !== "string") throw new ReviewError("review note must be text");
  return note.trim().slice(0, 4000);
}

function formValue(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function metadataFromForm(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const field of ["title", "summary", "description", "license", "homepage", "repository"]) {
    const value = formValue(payload, field);
    if (value !== undefined) metadata[field] = value;
  }
  const tags = formValue(payload, "tags");
  if (tags !== undefined) metadata.tags = tags.split(",").map((item) => item.trim()).filter(Boolean);
  return metadata;
}

function escapeHtml(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "[object]";
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function htmlPage(title: string, content: string, status = 200): { status: number; html: string } {
  return { status, html: `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>` };
}

function sendHtml(reply: FastifyReply, page: { status: number; html: string }): FastifyReply {
  return reply.code(page.status).header("content-type", "text/html; charset=utf-8").send(page.html);
}

function renderList(submissions: readonly SubmissionRecord[], status: string): string {
  const rows = submissions.map((submission) => `<tr><td>${submission.id}</td><td><a href="/editor/submissions/${submission.id}">${escapeHtml(submission.metadata.title ?? submission.game_id)}</a></td><td>${escapeHtml(submission.status)}</td><td>${escapeHtml(submission.created_at)}</td></tr>`).join("");
  return `<p>Status: ${escapeHtml(status)}</p><table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderDetail(submission: SubmissionRecord, csrfToken: string): string {
  const metadata = submission.metadata;
  const input = (name: string) => `<label>${escapeHtml(name)} <input name="${escapeHtml(name)}" value="${escapeHtml(metadata[name])}"></label>`;
  const token = `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">`;
  return `<p><a href="/editor/submissions">Back</a></p><p>Status: ${escapeHtml(submission.status)}</p><form method="post" action="/editor/submissions/${submission.id}/verify">${token}${input("title")}${input("summary")}${input("description")}<label>tags <input name="tags" value="${escapeHtml(Array.isArray(metadata.tags) ? metadata.tags.join(", ") : "")}"></label>${input("license")}${input("homepage")}${input("repository")}<button type="submit">Approve</button></form><form method="post" action="/editor/submissions/${submission.id}/reject">${token}<button type="submit">Reject</button></form>`;
}

function routeError(request: FastifyRequest, reply: FastifyReply, error: unknown, rejection = false): FastifyReply {
  request.log.warn({ err: error, requestId: request.id }, "review request rejected");
  const result = publicReviewError(error, rejection);
  return sendJson(reply, result.body, result.statusCode);
}

export function registerReviewRoutes(app: FastifyInstance, options: ReviewRouteOptions): void {
  const unavailable = (reply: FastifyReply) => sendJson(reply, { ok: false, error: "review write isolation is unavailable", code: "review_unavailable" }, 503);
  const review = () => options.review;

  app.get<{ Querystring: OwnedSubmissionQuery }>("/api/submissions/mine", async (request, reply) => {
    const service = review();
    if (!service) return unavailable(reply);
    const authContext = context(request, options.auth);
    if (!authContext.principal.authenticated) {
      return sendJson(reply, { ok: false, error: "login required", user: principalToJson(authContext.principal) }, 401);
    }
    if (!permissionGuard(options.authorization, authContext.principal, "catalog:submit")) {
      return sendJson(reply, { ok: false, error: "catalog submission permission required", code: "permission_denied" }, 403);
    }
    if (authContext.principal.id === null) {
      return sendJson(reply, { ok: false, error: "submission ownership is unavailable", code: "ownership_unavailable" }, 403);
    }
    try {
      const page = queryInteger(request.query.page, 1);
      const perPage = queryInteger(request.query.per_page, 25);
      return sendJson(reply, { ok: true, ...service.listMine(authContext.principal.id, request.query.status, page, perPage) });
    } catch (error) {
      return routeError(request, reply, error);
    }
  });

  app.get<{ Querystring: SubmissionQuery }>("/api/submissions", async (request, reply) => {
    const service = review();
    if (!service) return unavailable(reply);
    if (!authorized(request, reply, options, "submissions:read", false)) return reply;
    try { return sendJson(reply, { ok: true, submissions: service.list(request.query.status) }); }
    catch (error) { return routeError(request, reply, error); }
  });

  app.get<{ Params: SubmissionParams }>("/api/submissions/:submission_id", async (request, reply) => {
    const service = review();
    if (!service) return unavailable(reply);
    const authContext = context(request, options.auth);
    if (!authContext.principal.authenticated || authContext.principal.id === null) return sendJson(reply, { ok: false, error: "login required", user: principalToJson(authContext.principal) }, 401);
    try {
      const submission = service.detail(id(request));
      const reviewer = permissionGuard(options.authorization, authContext.principal, "submissions:read");
      const owner = permissionGuard(options.authorization, authContext.principal, "catalog:submit") && submission.submitted_by_user_id === authContext.principal.id;
      if (!reviewer && !owner) return sendJson(reply, { ok: false, error: "submission access denied", code: "permission_denied" }, 403);
      return sendJson(reply, { ok: true, submission });
    }
    catch (error) { return routeError(request, reply, error); }
  });

  app.post<{ Params: SubmissionParams }>("/api/submissions/:submission_id/verify", async (request, reply) => {
    const service = review();
    if (!service) return unavailable(reply);
    const principal = authorized(request, reply, options, "submissions:review", true);
    if (!principal) return reply;
    try { const payload = bodyObject(request); return sendJson(reply, { ok: true, submission: service.approve(id(request), metadataFromJson(payload), principal, noteFromJson(payload)) }); }
    catch (error) { return routeError(request, reply, error); }
  });

  app.post<{ Params: SubmissionParams }>("/api/submissions/:submission_id/reject", async (request, reply) => {
    const service = review();
    if (!service) return unavailable(reply);
    const principal = authorized(request, reply, options, "submissions:reject", true);
    if (!principal) return reply;
    try { return sendJson(reply, { ok: true, submission: service.reject(id(request), principal, noteFromJson(bodyObject(request))) }); }
    catch (error) { return routeError(request, reply, error, true); }
  });

  app.get<{ Querystring: SubmissionQuery }>("/editor/submissions", async (request, reply) => {
    const service = review();
    if (!service) return sendHtml(reply, htmlPage("Unavailable", "<p>Review is unavailable.</p>", 503));
    if (!authorized(request, reply, options, "submissions:read", false)) return reply;
    try { return sendHtml(reply, htmlPage("Submissions", renderList(service.list(request.query.status), request.query.status ?? "pending"))); }
    catch (error) { return sendHtml(reply, htmlPage("Invalid request", `<p>${escapeHtml(publicReviewError(error).body.error)}</p>`, 400)); }
  });

  app.get<{ Params: SubmissionParams }>("/editor/submissions/:submission_id", async (request, reply) => {
    const service = review();
    if (!service) return sendHtml(reply, htmlPage("Unavailable", "<p>Review is unavailable.</p>", 503));
    if (!authorized(request, reply, options, "submissions:read", false)) return reply;
    try { return sendHtml(reply, htmlPage("Submission", renderDetail(service.detail(id(request)), context(request, options.auth).session?.csrfToken ?? ""))); }
    catch (error) { const result = publicReviewError(error); return sendHtml(reply, htmlPage("Not found", `<p>${escapeHtml(result.body.error)}</p>`, result.statusCode)); }
  });

  app.post<{ Params: SubmissionParams }>("/editor/submissions/:submission_id/verify", async (request, reply) => {
    const service = review();
    if (!service) return sendHtml(reply, htmlPage("Unavailable", "<p>Review is unavailable.</p>", 503));
    let form: Record<string, unknown>;
    try { form = bodyObject(request); } catch (error) { return routeError(request, reply, error); }
    const principal = authorized(request, reply, options, "submissions:review", true, formValue(form, "csrf_token"));
    if (!principal) return reply;
    try { service.approve(id(request), metadataFromForm(form), principal); return reply.code(302).header("location", "/editor/submissions").send(); }
    catch (error) { const result = publicReviewError(error); return sendHtml(reply, htmlPage("Invalid request", `<p>${escapeHtml(result.body.error)}</p>`, result.statusCode)); }
  });

  app.post<{ Params: SubmissionParams }>("/editor/submissions/:submission_id/reject", async (request, reply) => {
    const service = review();
    if (!service) return sendHtml(reply, htmlPage("Unavailable", "<p>Review is unavailable.</p>", 503));
    let form: Record<string, unknown>;
    try { form = bodyObject(request); } catch (error) { return routeError(request, reply, error, true); }
    const principal = authorized(request, reply, options, "submissions:reject", true, formValue(form, "csrf_token"));
    if (!principal) return reply;
    try { service.reject(id(request), principal, formValue(form, "note") ?? ""); return reply.code(302).header("location", "/editor/submissions").send(); }
    catch (error) { const result = publicReviewError(error, true); return sendHtml(reply, htmlPage("Invalid request", `<p>${escapeHtml(result.body.error)}</p>`, result.statusCode)); }
  });
}
