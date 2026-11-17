/**
 * Shared transaction and audit boundary for administrative mutations.
 */

import type Database from "better-sqlite3";

import type { AdminAuditLog } from "./audit.js";
import { sqliteErrorCode } from "./codecs.js";
import { AdminError } from "./errors.js";
import type { AdminMutationContext } from "./service-contracts.js";

/** Executes one audited administrative mutation in the writer transaction. */
export function runAdminMutation<T>(options: {
  readonly writableDatabase: Database.Database | null;
  readonly audit: AdminAuditLog;
  readonly context: AdminMutationContext;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly callback: (database: Database.Database) => T;
}): T {
  const {
    action,
    audit,
    callback,
    context,
    targetId,
    targetType,
    writableDatabase
  } = options;
  if (!writableDatabase) {
    throw new AdminError(
      "admin_write_unavailable",
      503,
      "administrative writes are unavailable"
    );
  }
  audit.ensureReady();
  audit.append({
    actor_user_id: context.actorUserId,
    target_type: targetType,
    target_id: targetId,
    action,
    outcome: "attempted",
    request_id: context.requestId
  });
  try {
    writableDatabase.exec("BEGIN IMMEDIATE");
    const result = callback(writableDatabase);
    writableDatabase.exec("COMMIT");
    try {
      audit.append({
        actor_user_id: context.actorUserId,
        target_type: targetType,
        target_id: targetId,
        action,
        outcome: "committed",
        request_id: context.requestId
      });
    } catch {
      // SQLite is already committed. Preserve the established behavior.
    }
    return result;
  } catch (error) {
    if (writableDatabase.inTransaction) writableDatabase.exec("ROLLBACK");
    try {
      audit.append({
        actor_user_id: context.actorUserId,
        target_type: targetType,
        target_id: targetId,
        action,
        outcome: "failed",
        request_id: context.requestId
      });
    } catch {
      // Preserve the original stable mutation error.
    }
    if (error instanceof AdminError) throw error;
    const code = sqliteErrorCode(error);
    if (code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new AdminError(
        "identity_conflict",
        409,
        "identity value already exists"
      );
    }
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      throw new AdminError(
        "user_delete_restricted",
        409,
        "user has protected historical references"
      );
    }
    throw new AdminError(
      "admin_operation_failed",
      500,
      "administrative operation failed"
    );
  }
}
