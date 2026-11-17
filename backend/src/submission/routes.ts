import crypto from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { parseCookies } from "../auth/session.js";
import type { AuthService } from "../auth/service.js";
import type { BackendConfig } from "../config/env.js";
import type { AuthorizationService } from "../authorization/service.js";
import { permissionGuard } from "../authorization/guards.js";
import { encodePythonJson } from "../compatibility/serialization.js";
import { publicSubmissionError, SubmissionError } from "./errors.js";
import type { SubmissionService } from "./service.js";

interface SubmissionRouteOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly authorization: AuthorizationService;
  readonly submission: Pick<SubmissionService, "createFromBundle"> | null;
}

interface MultipartPayload {
  readonly bundle: Uint8Array;
  readonly csrfToken: string;
}

function sendJson(reply: FastifyReply, body: unknown, status?: number): FastifyReply {
  if (status !== undefined) reply.code(status);
  return reply.header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

function timingSafeEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

function bearer(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim() || undefined;
  const legacy = request.headers["x-prg32-token"];
  return typeof legacy === "string" ? legacy.trim() || undefined : undefined;
}

function current(request: FastifyRequest, auth: AuthService) {
  return auth.context(parseCookies(request.headers.cookie).get("prg32_ts_session"), bearer(request));
}

function csrfHeader(request: FastifyRequest, field: string): string {
  const header = request.headers["x-csrftoken"] ?? request.headers["x-csrf-token"];
  return typeof header === "string" ? header.trim() : field.trim();
}

function authorizationFailure(reply: FastifyReply): FastifyReply {
  return sendJson(reply, {
    ok: false,
    error: "login required",
    user: { id: null, name: "anonymous", username: "anonymous", email: "", role: "reader", groups: [], authenticated: false }
  }, 401);
}

function unavailable(reply: FastifyReply): FastifyReply {
  return sendJson(reply, { ok: false, error: "publishing write isolation is unavailable", code: "submission_unavailable" }, 503);
}

async function readMultipart(request: FastifyRequest, config: BackendConfig): Promise<MultipartPayload> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new SubmissionError("package upload required: upload a cartridge bundle (.zip)");
  }
  let bundle: Uint8Array | undefined;
  let csrfToken = "";
  try {
    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "csrf_token" && typeof part.value === "string") csrfToken = part.value;
        continue;
      }
      if (part.fieldname !== "bundle") {
        part.file.resume();
        continue;
      }
      const chunks: Buffer<ArrayBufferLike>[] = [];
      let length = 0;
      for await (const chunk of part.file) {
        const bytes: Buffer<ArrayBufferLike> = Buffer.isBuffer(chunk)
          ? Buffer.from(chunk)
          : Buffer.from(chunk as Uint8Array);
        length += bytes.byteLength;
        if (length > config.submissionMaxArchiveBytes) {
          part.file.resume();
          throw new SubmissionError("bundle upload is too large", "submission_payload_too_large", 413);
        }
        chunks.push(bytes);
      }
      bundle = Buffer.concat(chunks, length);
    }
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.toLowerCase().includes("file too large")) throw new SubmissionError("bundle upload is too large", "submission_payload_too_large", 413);
    throw new SubmissionError("bundle must be a valid multipart upload");
  }
  if (!bundle) throw new SubmissionError("missing upload: bundle");
  return { bundle, csrfToken };
}

async function handleSubmission(request: FastifyRequest, reply: FastifyReply, options: SubmissionRouteOptions, legacyEndpoint: boolean, htmlRedirect: boolean): Promise<FastifyReply> {
  if (!options.submission) return unavailable(reply);
  const authContext = current(request, options.auth);
  if (!authContext.principal.authenticated) return authorizationFailure(reply);
  if (!permissionGuard(options.authorization, authContext.principal, "catalog:submit")) return authorizationFailure(reply);
  const payload = await readMultipart(request, options.config);
  if (!authContext.bearerOnly && (!authContext.session || !timingSafeEqual(authContext.session.csrfToken, csrfHeader(request, payload.csrfToken)))) {
    return sendJson(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
  }
  try {
    const result = options.submission.createFromBundle(payload.bundle, authContext.principal);
    if (htmlRedirect) return reply.code(302).header("location", "/publish").send();
    return sendJson(reply, legacyEndpoint ? { ...result, legacy_endpoint: true } : result);
  } catch (error) {
    const publicError = publicSubmissionError(error);
    request.log.warn({ err: error, requestId: request.id }, "submission rejected");
    return sendJson(reply, publicError.body, publicError.statusCode);
  }
}

export function registerSubmissionRoutes(app: FastifyInstance, options: SubmissionRouteOptions): void {
  app.post("/publish", async (request, reply) => handleSubmission(request, reply, options, false, true));
  app.post("/api/publish", async (request, reply) => handleSubmission(request, reply, options, true, false));
  app.post("/api/publish/bundle", async (request, reply) => handleSubmission(request, reply, options, false, false));
}
