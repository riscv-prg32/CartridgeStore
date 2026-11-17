import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { encodePythonJson } from "../compatibility/serialization.js";
import type { BackendConfig } from "../config/env.js";
import { permissionGuard } from "../authorization/guards.js";
import type { AuthorizationService } from "../authorization/service.js";
import type { Permission } from "../authorization/permissions.js";
import { parseCookies } from "../auth/session.js";
import type { AuthRequestContext, AuthService } from "../auth/service.js";
import { SettingsError, MAX_ASSET_BYTES, type SettingsService } from "./service.js";
import { SettingsValidationError } from "./schemas.js";

const SESSION_COOKIE = "prg32_ts_session";
type AssetKind = "logo" | "favicon";

interface SettingsRouteOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly authorization: AuthorizationService;
  readonly settings: SettingsService;
}

function json(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

function bearer(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim() || undefined;
  }
  const legacy = request.headers["x-prg32-token"];
  return typeof legacy === "string" ? legacy.trim() || undefined : undefined;
}

function context(request: FastifyRequest, auth: AuthService): AuthRequestContext {
  return auth.context(parseCookies(request.headers.cookie).get(SESSION_COOKIE), bearer(request));
}

function constantTimeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function adminFailure(reply: FastifyReply, status: 401 | 403): FastifyReply {
  return json(reply, {
    ok: false,
    error: status === 401 ? "login required" : "administrator privileges required",
    code: status === 401 ? "auth_required" : "admin_required"
  }, status);
}

function csrfFailure(reply: FastifyReply): FastifyReply {
  return json(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
}

function csrfHeader(request: FastifyRequest, formToken = ""): string {
  const header = request.headers["x-csrftoken"] ?? request.headers["x-csrf-token"];
  return typeof header === "string" ? header.trim() : formToken.trim();
}

function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SettingsRouteOptions,
  mutation: boolean,
  formToken = "",
  requiredPermission: Permission = mutation ? "settings:write" : "settings:read"
): AuthRequestContext | null {
  const current = context(request, options.auth);
  if (!current.principal.authenticated) {
    adminFailure(reply, 401);
    return null;
  }
  if (!permissionGuard(options.authorization, current.principal, requiredPermission)) {
    adminFailure(reply, 403);
    return null;
  }
  if (mutation && current.bearerOnly) {
    json(reply, { ok: false, error: "browser session required", code: "settings_browser_session_required" }, 403);
    return null;
  }
  if (mutation && (!current.session || !csrfHeader(request, formToken) || !constantTimeEqual(current.session.csrfToken, csrfHeader(request, formToken)))) {
    csrfFailure(reply);
    return null;
  }
  return current;
}

function operationFailure(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply {
  request.log.warn({ err: error, requestId: request.id }, "settings request rejected");
  if (error instanceof SettingsValidationError) {
    return json(reply, { ok: false, error: "invalid settings request", code: error.code }, error.statusCode);
  }
  if (error instanceof SettingsError) {
    const publicErrors: Record<string, string> = {
      settings_conflict: "settings update conflicted with a newer version",
      settings_invalid_value: "invalid settings request",
      mdns_infrastructure_denied: "mDNS is disabled by deployment policy",
      mdns_runtime_failed: "mDNS could not be updated",
      smtp_invalid_configuration: "SMTP configuration is invalid",
      smtp_disabled: "SMTP delivery is disabled; enable SMTP and save settings first",
      smtp_connection_failed: "SMTP connection failed",
      smtp_delivery_failed: "SMTP test message failed",
      provider_private_target_denied: "SMTP target is blocked by the server network policy",
      provider_dns_failed: "SMTP host could not be resolved",
      provider_host_invalid: "SMTP host is invalid",
      provider_port_invalid: "SMTP port is invalid",
      secret_storage_unavailable: "secret storage is unavailable",
      smtp_unavailable: "SMTP delivery is unavailable",
      smtp_test_recipient_invalid: "test recipient is invalid",
      asset_not_found: "asset not found",
      asset_unavailable: "asset unavailable"
    };
    return json(reply, { ok: false, error: publicErrors[error.code] ?? "settings operation failed", code: error.code }, error.statusCode);
  }
  return json(reply, { ok: false, error: "settings operation failed", code: "settings_operation_failed" }, 500);
}

function validKind(value: string): value is AssetKind {
  return value === "logo" || value === "favicon";
}

async function readAssetUpload(request: FastifyRequest, kind: AssetKind): Promise<{ readonly data: Buffer; readonly csrfToken: string }> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new SettingsError("asset_upload_invalid", 400, "asset upload must use multipart/form-data");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let foundFile = false;
  let formCsrfToken = "";
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (foundFile || part.fieldname !== "asset") {
          part.file.resume();
          throw new SettingsError("asset_upload_invalid", 400, `${kind} upload must contain one asset file`);
        }
        foundFile = true;
        for await (const chunk of part.file as AsyncIterable<Buffer | string>) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > MAX_ASSET_BYTES) {
            part.file.resume();
            throw new SettingsError("asset_too_large", 413, `${kind} upload is too large`);
          }
          chunks.push(bytes);
        }
        if (part.file.truncated) throw new SettingsError("asset_too_large", 413, `${kind} upload is too large`);
      } else if (part.fieldname === "csrf_token" && typeof part.value === "string") {
        formCsrfToken = part.value;
      }
    }
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    throw new SettingsError("asset_upload_invalid", 400, "asset upload is invalid", { cause: error });
  }
  if (!foundFile) throw new SettingsError("asset_upload_missing", 400, `${kind} asset is required`);
  return { data: Buffer.concat(chunks, total), csrfToken: formCsrfToken };
}

async function serveAsset(reply: FastifyReply, settings: SettingsService, kind: AssetKind, filename?: string): Promise<FastifyReply> {
  const asset = settings.assetPath(kind);
  if (!asset || (filename !== undefined && path.basename(asset.path) !== filename)) {
    return json(reply, { ok: false, error: "asset not found", code: "asset_not_found" }, 404);
  }
  try {
    const stats = fs.lstatSync(asset.path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return json(reply, { ok: false, error: "asset not found", code: "asset_not_found" }, 404);
    }
    if (kind === "favicon" && asset.mimeType === "image/webp") {
      // Browsers are inconsistent about accepting WebP through a /favicon.ico
      // redirect. Keep old uploads working by converting them at the edge.
      const png = await sharp(asset.path).png({ compressionLevel: 9 }).toBuffer();
      return reply
        .header("content-type", "image/png")
        .header("cache-control", "public, max-age=300")
        .header("x-content-type-options", "nosniff")
        .send(png);
    }
    return reply
      .header("content-type", asset.mimeType)
      .header("cache-control", "public, max-age=300")
      .header("x-content-type-options", "nosniff")
      .send(fs.createReadStream(asset.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return json(reply, { ok: false, error: "asset not found", code: "asset_not_found" }, 404);
    }
    return json(reply, { ok: false, error: "asset unavailable", code: "asset_unavailable" }, 503);
  }
}

export function registerSettingsRoutes(app: FastifyInstance, options: SettingsRouteOptions): void {
  app.get("/api/admin/settings", async (request, reply) => {
    if (!requireAdmin(request, reply, options, false)) return reply;
    try {
      return json(reply, options.settings.read());
    } catch (error) {
      return operationFailure(reply, request, error);
    }
  });

  app.patch("/api/admin/settings", async (request, reply) => {
    if (!options.auth.isWriteEnabled()) return json(reply, { ok: false, error: "settings write isolation is unavailable", code: "settings_unavailable" }, 503);
    try {
      const current = requireAdmin(request, reply, options, true);
      if (!current) return reply;
      if (current.principal.id === null) return adminFailure(reply, 401);
      return json(reply, await options.settings.update(request.body, { actorUserId: current.principal.id, requestId: request.id }));
    } catch (error) {
      return operationFailure(reply, request, error);
    }
  });

  app.post("/api/admin/settings/smtp/test-connection", async (request, reply) => {
    const current = requireAdmin(request, reply, options, true);
    if (!current) return reply;
    try {
      await options.settings.testSmtpConnection();
      return json(reply, { ok: true, result: "smtp_connection_ok" });
    } catch (error) { return operationFailure(reply, request, error); }
  });

  app.post("/api/admin/settings/smtp/test-message", async (request, reply) => {
    const current = requireAdmin(request, reply, options, true);
    if (!current) return reply;
    try {
      const body = request.body;
      if (body === null || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>).to !== "string") {
        throw new SettingsError("smtp_test_recipient_invalid", 400, "test recipient is invalid");
      }
      await options.settings.sendSmtpTest((body as Record<string, unknown>).to as string);
      return json(reply, { ok: true, result: "smtp_message_accepted" });
    } catch (error) { return operationFailure(reply, request, error); }
  });

  for (const kind of ["logo", "favicon"] as const) {
    app.post(`/api/admin/settings/assets/${kind}`, async (request, reply) => {
      if (!options.auth.isWriteEnabled()) return json(reply, { ok: false, error: "settings write isolation is unavailable", code: "settings_unavailable" }, 503);
      try {
        const upload = await readAssetUpload(request, kind);
        if (!requireAdmin(request, reply, options, true, upload.csrfToken, "settings:assets:write")) return reply;
        return json(reply, { ok: true, asset: await options.settings.replaceAsset(kind, upload.data) });
      } catch (error) {
        return operationFailure(reply, request, error);
      }
    });
    app.delete(`/api/admin/settings/assets/${kind}`, async (request, reply) => {
      if (!options.auth.isWriteEnabled()) return json(reply, { ok: false, error: "settings write isolation is unavailable", code: "settings_unavailable" }, 503);
      try {
        if (!requireAdmin(request, reply, options, true, "", "settings:assets:write")) return reply;
        return json(reply, { ok: true, asset: options.settings.removeAsset(kind) });
      } catch (error) {
        return operationFailure(reply, request, error);
      }
    });
  }

  app.get<{ Params: { asset: string; filename: string } }>("/api/assets/:asset/:filename", async (request, reply) => {
    if (!validKind(request.params.asset)) return json(reply, { ok: false, error: "asset not found", code: "asset_not_found" }, 404);
    return await serveAsset(reply, options.settings, request.params.asset, request.params.filename);
  });
  app.get<{ Params: { asset: string } }>("/api/assets/:asset", async (request, reply) => {
    if (!validKind(request.params.asset)) return json(reply, { ok: false, error: "asset not found", code: "asset_not_found" }, 404);
    return await serveAsset(reply, options.settings, request.params.asset);
  });
}
