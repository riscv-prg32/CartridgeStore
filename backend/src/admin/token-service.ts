import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { AdminError, type AdminMutationContext } from "./service.js";
import { AdminAuditLog } from "./audit.js";

type DatabaseSource = Database.Database | (() => Database.Database);

export interface AdminTokenView {
  readonly id: number;
  readonly user_id: number;
  readonly username: string;
  readonly label: string;
  readonly created_at: string;
  readonly last_used: string;
}

export interface AdminTokenListOptions {
  readonly page: number;
  readonly limit: number;
  readonly ownerId?: number;
}

export class AdminTokenService {
  private readonly source: DatabaseSource;
  private readonly writable: Database.Database | null;
  private readonly audit: AdminAuditLog;

  constructor(options: {
    readonly config: BackendConfig;
    readonly database: DatabaseSource;
    readonly writableDatabase: Database.Database | null;
    readonly audit?: AdminAuditLog;
  }) {
    this.source = options.database;
    this.writable = options.writableDatabase;
    this.audit = options.audit ?? new AdminAuditLog(options.config);
  }

  private get database(): Database.Database {
    return typeof this.source === "function" ? this.source() : this.source;
  }

  private requireWriter(): Database.Database {
    if (!this.writable) throw new AdminError("admin_write_unavailable", 503, "administrative writes are unavailable");
    return this.writable;
  }

  list(options: AdminTokenListOptions): { readonly tokens: readonly AdminTokenView[]; readonly page: number; readonly limit: number; readonly total: number } {
    const page = options.page;
    const limit = options.limit;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AdminError("invalid_pagination", 400, "pagination is invalid");
    }
    if (options.ownerId !== undefined && (!Number.isSafeInteger(options.ownerId) || options.ownerId < 1)) {
      throw new AdminError("invalid_filter", 400, "user_id is invalid");
    }

    const filters: string[] = [];
    const values: Array<number> = [];
    if (options.ownerId !== undefined) {
      filters.push("api_tokens.user_id = ?");
      values.push(options.ownerId);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const database = this.database;
    const total = Number((database.prepare(`SELECT COUNT(*) AS count FROM api_tokens ${where}`).get(...values) as { count: number }).count);
    const rows = database.prepare(
      `SELECT api_tokens.id, api_tokens.user_id, users.username, api_tokens.label,
              api_tokens.created_at, api_tokens.last_used
         FROM api_tokens
         JOIN users ON users.id = api_tokens.user_id
         ${where}
        ORDER BY api_tokens.created_at DESC, api_tokens.id DESC
        LIMIT ? OFFSET ?`
    ).all(...values, limit, (page - 1) * limit) as Array<{
      id: number;
      user_id: number;
      username: string;
      label: string | null;
      created_at: string;
      last_used: string | null;
    }>;
    return {
      tokens: rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        username: row.username,
        label: row.label || "API token",
        created_at: row.created_at,
        last_used: row.last_used || ""
      })),
      page,
      limit,
      total
    };
  }

  recordRejected(actorUserId: number, targetId: string, action: string, requestId: string): void {
    this.audit.rejected(actorUserId, "api_token", targetId, action, requestId);
  }

  revoke(tokenId: number, context: AdminMutationContext): { readonly token_id: number } {
    if (!Number.isSafeInteger(tokenId) || tokenId < 1) throw new AdminError("invalid_identifier", 400, "token_id is invalid");
    const database = this.requireWriter();
    const action = "api_token.revoke";
    const targetId = String(tokenId);
    this.audit.ensureReady();
    this.audit.append({
      actor_user_id: context.actorUserId,
      target_type: "api_token",
      target_id: targetId,
      action,
      outcome: "attempted",
      request_id: context.requestId
    });
    try {
      database.exec("BEGIN IMMEDIATE");
      const deleted = database.prepare("DELETE FROM api_tokens WHERE id = ?").run(tokenId).changes;
      if (deleted !== 1) throw new AdminError("token_not_found", 404, "token not found");
      database.exec("COMMIT");
      try {
        this.audit.append({
          actor_user_id: context.actorUserId,
          target_type: "api_token",
          target_id: targetId,
          action,
          outcome: "committed",
          request_id: context.requestId
        });
      } catch {
        // SQLite is already committed. The cross-persistence limitation is
        // documented; the mutation is never represented as an invented audit
        // success when the append fails.
      }
      return { token_id: tokenId };
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      try {
        this.audit.append({
          actor_user_id: context.actorUserId,
          target_type: "api_token",
          target_id: targetId,
          action,
          outcome: "failed",
          request_id: context.requestId
        });
      } catch {
        // Preserve the original stable error.
      }
      if (error instanceof AdminError) throw error;
      throw new AdminError("admin_operation_failed", 500, "administrative token operation failed");
    }
  }
}
