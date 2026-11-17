import crypto from "node:crypto";
import fs from "node:fs";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { encodePythonJson } from "../compatibility/serialization.js";
import type { BackendConfig } from "../config/env.js";
import type { AuthorizationService } from "../authorization/service.js";
import { permissionGuard } from "../authorization/guards.js";
import { parseCookies } from "../auth/session.js";
import type { AuthRequestContext, AuthService } from "../auth/service.js";
import { BackupError } from "./format.js";
import type { BackupArtifact, BackupService } from "./service.js";

const SESSION_COOKIE = "prg32_ts_session";

interface BackupRouteOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly authorization: AuthorizationService;
  readonly backup: BackupService | null;
}

function json(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "application/json").send(Buffer.from(encodePythonJson(body) + "\n", "utf8"));
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

function csrfToken(request: FastifyRequest, formToken: string): string {
  const header = request.headers["x-csrftoken"] ?? request.headers["x-csrf-token"];
  if (typeof header === "string") return header.trim();
  return formToken.trim();
}

function adminFailure(reply: FastifyReply, status: 401 | 403): FastifyReply {
  return json(reply, {
    ok: false,
    error: status === 401 ? "login required" : "administrator privileges required",
    code: status === 401 ? "auth_required" : "admin_required"
  }, status);
}

function backupFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BackupError) {
    return json(reply, { ok: false, error: error.message, code: error.code }, error.statusCode);
  }
  return json(reply, { ok: false, error: "backup operation failed", code: "backup_operation_failed" }, 500);
}

function passwordHeader(request: FastifyRequest): string {
  const value = request.headers["x-prg32-backup-password"];
  return typeof value === "string" ? value : "";
}

async function streamToFile(stream: NodeJS.ReadableStream, target: string, maxBytes: number): Promise<number> {
  const fd = fs.openSync(target, "wx", 0o600);
  let total = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) throw new BackupError("backup archive is too large", "backup_archive_too_large", 413);
      fs.writeSync(fd, bytes);
    }
    fs.fsyncSync(fd);
    return total;
  } finally {
    fs.closeSync(fd);
  }
}

async function readUpload(request: FastifyRequest, config: BackendConfig): Promise<{ readonly path: string; readonly password: string; readonly csrfToken: string }> {
  const directory = fs.mkdtempSync("/tmp/prg32-backup-upload-");
  const target = directory + "/upload.bin";
  let password = passwordHeader(request);
  let formCsrfToken = "";
  let foundFile = false;
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (foundFile || part.fieldname !== "backup") throw new BackupError("one backup file is required", "backup_upload_invalid");
        foundFile = true;
        await streamToFile(part.file, target, config.backupMaxArchiveBytes);
        if (part.file.truncated) throw new BackupError("backup archive is too large", "backup_archive_too_large", 413);
      } else if (part.fieldname === "backup_password" && typeof part.value === "string") {
        password = part.value;
      } else if (part.fieldname === "csrf_token" && typeof part.value === "string") {
        formCsrfToken = part.value;
      }
    }
    if (!foundFile) throw new BackupError("backup file is required", "backup_upload_missing");
    return { path: target, password, csrfToken: formCsrfToken };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    if (error instanceof BackupError) throw error;
    throw new BackupError("backup upload is invalid", "backup_upload_invalid", 400, { cause: error });
  }
}

function cleanupUpload(uploadPath: string): void {
  const directory = pathDirectory(uploadPath);
  fs.rmSync(directory, { recursive: true, force: true });
}

function pathDirectory(filePath: string): string {
  const separator = filePath.lastIndexOf("/");
  return separator > 0 ? filePath.slice(0, separator) : filePath;
}

function requireDownloadAdmin(request: FastifyRequest, reply: FastifyReply, auth: AuthService, authorization: AuthorizationService): AuthRequestContext | null {
  const current = context(request, auth);
  if (!current.principal.authenticated) {
    adminFailure(reply, 401);
    return null;
  }
  if (!permissionGuard(authorization, current.principal, "backup:export")) {
    adminFailure(reply, 403);
    return null;
  }
  return current;
}

function requireRestoreAdmin(request: FastifyRequest, reply: FastifyReply, auth: AuthService, authorization: AuthorizationService, formToken = ""): AuthRequestContext | null {
  const current = context(request, auth);
  if (!current.principal.authenticated) {
    adminFailure(reply, 401);
    return null;
  }
  if (current.bearerOnly) {
    json(reply, { ok: false, error: "browser session required for restore", code: "backup_bearer_restore_disabled" }, 403);
    return null;
  }
  if (!current.session || !constantTimeEqual(current.session.csrfToken, csrfToken(request, formToken))) {
    json(reply, { ok: false, error: "csrf token missing or invalid", code: "csrf_failed" }, 403);
    return null;
  }
  if (!permissionGuard(authorization, current.principal, "backup:restore")) {
    adminFailure(reply, 403);
    return null;
  }
  return current;
}

export function registerBackupRoutes(app: FastifyInstance, options: BackupRouteOptions): void {
  if (!options.config.backupEnabled || !options.backup) return;
  const service = options.backup;
  app.get("/admin/backup/download", async (request, reply) => {
    const current = requireDownloadAdmin(request, reply, options.auth, options.authorization);
    if (!current) return reply;
    let artifact: BackupArtifact | undefined;
    try {
      artifact = await service.export(passwordHeader(request));
      const stream = fs.createReadStream(artifact.path);
      const cleanup = () => { if (artifact) service.cleanupArtifact(artifact); };
      stream.once("close", cleanup);
      stream.once("error", cleanup);
      return reply
        .header("content-type", artifact.encrypted ? "application/octet-stream" : "application/zip")
        .header("content-disposition", "attachment; filename=" + artifact.filename)
        .header("cache-control", "no-store")
        .send(stream);
    } catch (error) {
      if (artifact) service.cleanupArtifact(artifact);
      return backupFailure(reply, error);
    }
  });

  app.post("/admin/backup/restore", async (request, reply) => {
    let upload: { readonly path: string; readonly password: string; readonly csrfToken: string } | undefined;
    try {
      upload = await readUpload(request, options.config);
      const current = requireRestoreAdmin(request, reply, options.auth, options.authorization, upload.csrfToken);
      if (!current) {
        cleanupUpload(upload.path);
        return reply;
      }
      const result = await service.restore(upload.path, upload.password);
      cleanupUpload(upload.path);
      // A restored identity database can contain a different revocation
      // marker set. Process-local browser sessions must not survive that
      // identity transition; restored bearer rows remain governed by the
      // restored database and its compatibility semantics.
      options.auth.invalidateAllSessions();
      return json(reply, { ok: true, ...result });
    } catch (error) {
      if (upload) cleanupUpload(upload.path);
      return backupFailure(reply, error);
    }
  });
}
