import type Database from "better-sqlite3";

import {
  hasAccountStateColumn,
  hasAccountStatusColumn,
} from "../auth/account-state.js";
import { ROLE_LEVELS } from "../auth/principal.js";
import {
  normalizeAdminRole,
  parseAdminAuditSummary,
  positiveAdminId,
} from "./codecs.js";
import {
  adminUserFromRow,
  type AdminUserRow,
} from "./user-view.js";
import type { GroupView, UserView } from "./service-contracts.js";

/** Filters and pagination accepted by the administrative user read model. */
export interface AdminUserListOptions {
  readonly page: number;
  readonly limit: number;
  readonly query?: string;
  readonly role?: string;
  readonly groupId?: number;
}

/** Lists users with the stable administrative filters and pagination. */
export function listAdminUsers(
  database: Database.Database,
  options: AdminUserListOptions,
): {
  readonly users: readonly UserView[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
} {
  const limit = Math.min(Math.max(options.limit, 1), 100);
  const page = Math.max(options.page, 1);
  const filters: string[] = [];
  const values: Array<string | number> = [];

  if (options.query) {
    const escaped = options.query.replace(/[\\%_]/g, (item) => `\\${item}`);
    filters.push(
      "(users.username LIKE ? ESCAPE '\\' OR users.email LIKE ? ESCAPE '\\')",
    );
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (options.role) {
    const role = normalizeAdminRole(options.role);
    filters.push("users.role = ?");
    values.push(role);
  }
  if (options.groupId !== undefined) {
    positiveAdminId(options.groupId, "group_id");
    filters.push(
      "EXISTS (SELECT 1 FROM user_groups filter_ug " +
        "WHERE filter_ug.user_id = users.id AND filter_ug.group_id = ?)",
    );
    values.push(options.groupId);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const disabledColumn = hasAccountStateColumn(database)
    ? "users.disabled_at"
    : "NULL AS disabled_at";
  const statusColumns = hasAccountStatusColumn(database)
    ? "users.account_status, users.status_reason, users.status_changed_at, " +
      "users.status_expires_at"
    : "NULL AS account_status, NULL AS status_reason, " +
      "NULL AS status_changed_at, NULL AS status_expires_at";
  const total = Number(
    (
      database
        .prepare(`SELECT COUNT(*) AS count FROM users ${where}`)
        .get(...values) as { count: number }
    ).count,
  );
  const rows = database
    .prepare(
      `SELECT users.id, users.username, users.email, users.role,
              users.external_provider, users.created_at, users.last_login,
              ${disabledColumn}, ${statusColumns},
              (SELECT json_group_array(json_object(
                'id', groups.id, 'name', groups.name,
                'created_at', groups.created_at))
                 FROM user_groups JOIN groups
                   ON groups.id = user_groups.group_id
                WHERE user_groups.user_id = users.id) AS groups_json
         FROM users ${where}
        ORDER BY users.created_at ASC, users.id ASC LIMIT ? OFFSET ?`,
    )
    .all(...values, limit, (page - 1) * limit) as AdminUserRow[];

  return {
    users: rows.map((row) => adminUserFromRow(database, row)),
    page,
    limit,
    total,
  };
}

/** Lists groups with their current membership counts. */
export function listAdminGroups(
  database: Database.Database,
  limitValue: number,
): { readonly groups: readonly GroupView[]; readonly limit: number } {
  const limit = Math.min(Math.max(limitValue, 1), 100);
  const rows = database
    .prepare(
      `SELECT groups.id, groups.name, groups.created_at,
              COUNT(user_groups.user_id) AS user_count
         FROM groups LEFT JOIN user_groups
           ON user_groups.group_id = groups.id
        GROUP BY groups.id ORDER BY groups.name ASC, groups.id ASC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    name: string;
    created_at: string;
    user_count: number;
  }>;
  return { groups: rows, limit };
}

/** Lists configured roles and their current user counts. */
export function listAdminRoles(
  database: Database.Database,
): readonly Record<string, unknown>[] {
  return Object.entries(ROLE_LEVELS).map(([name, level]) => ({
    name,
    level,
    user_count: Number(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM users WHERE role = ?")
          .get(name) as { count: number }
      ).count,
    ),
  }));
}

/** Lists bounded administrative audit events when the audit table exists. */
export function listAdminAudit(
  database: Database.Database,
  limitValue: number,
): { readonly events: readonly Record<string, unknown>[]; readonly limit: number } {
  const limit = Math.min(Math.max(Math.trunc(limitValue), 1), 200);
  const hasTable = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master " +
          "WHERE type = 'table' AND name = 'admin_audit_events'",
      )
      .get(),
  );
  if (!hasTable) return { events: [], limit };

  const rows = database
    .prepare(
      "SELECT event_id, timestamp, actor_user_id, target_type, target_id, " +
        "action, outcome, summary_json, request_id " +
        "FROM admin_audit_events ORDER BY timestamp DESC, event_id DESC " +
        "LIMIT ?",
    )
    .all(limit) as Array<{
    event_id: string;
    timestamp: string;
    actor_user_id: number | null;
    target_type: string;
    target_id: string;
    action: string;
    outcome: string;
    summary_json: string;
    request_id: string;
  }>;

  return {
    limit,
    events: rows.map((row) => ({
      event_id: row.event_id,
      timestamp: row.timestamp,
      actor_user_id: row.actor_user_id,
      target_type: row.target_type,
      target_id: row.target_id,
      action: row.action,
      outcome: row.outcome,
      summary: parseAdminAuditSummary(row.summary_json),
      request_id: row.request_id,
    })),
  };
}

/** Reads one administrative audit event by its stable identifier. */
export function getAdminAudit(
  database: Database.Database,
  eventId: string,
): Record<string, unknown> | null {
  const normalizedId = eventId.trim();
  if (!normalizedId) return null;
  const hasTable = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master " +
          "WHERE type = 'table' AND name = 'admin_audit_events'",
      )
      .get(),
  );
  if (!hasTable) return null;

  const row = database
    .prepare(
      "SELECT event_id, timestamp, actor_user_id, target_type, target_id, " +
        "action, outcome, summary_json, request_id " +
        "FROM admin_audit_events WHERE event_id = ?",
    )
    .get(normalizedId) as {
    event_id: string;
    timestamp: string;
    actor_user_id: number | null;
    target_type: string;
    target_id: string;
    action: string;
    outcome: string;
    summary_json: string;
    request_id: string;
  } | undefined;
  if (!row) return null;

  return {
    event_id: row.event_id,
    timestamp: row.timestamp,
    actor_user_id: row.actor_user_id,
    target_type: row.target_type,
    target_id: row.target_id,
    action: row.action,
    outcome: row.outcome,
    summary: parseAdminAuditSummary(row.summary_json),
    request_id: row.request_id,
  };
}
