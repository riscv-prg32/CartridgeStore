import type Database from "better-sqlite3";

import {
  accountStatus,
  hasAccountStateColumn,
  hasAccountStatusColumn,
} from "../auth/account-state.js";
import { normalizeRole, type Role } from "../auth/principal.js";
import { parseAdminGroups } from "./codecs.js";
import type { UserView } from "./service-contracts.js";
import { AdminError } from "./errors.js";

/** Database row required to build an administrative user view. */
export interface AdminUserRow {
  readonly id: number;
  readonly username: string;
  readonly email: string;
  readonly role: string;
  readonly external_provider: string | null;
  readonly created_at: string;
  readonly last_login: string | null;
  readonly groups_json: string | null;
  readonly disabled_at: string | null;
  readonly account_status?: string | null;
  readonly status_reason?: string | null;
  readonly status_changed_at?: string | null;
  readonly status_expires_at?: string | null;
}

/** Loads one user with groups and account-state compatibility columns. */
export function readAdminUser(
  database: Database.Database,
  userId: number,
): UserView {
  const disabledColumn = hasAccountStateColumn(database)
    ? "users.disabled_at"
    : "NULL AS disabled_at";
  const statusColumns = hasAccountStatusColumn(database)
    ? "users.account_status, users.status_reason, " +
      "users.status_changed_at, users.status_expires_at"
    : "NULL AS account_status, NULL AS status_reason, " +
      "NULL AS status_changed_at, NULL AS status_expires_at";
  const row = database
    .prepare(
      `SELECT id, username, email, role, external_provider, created_at, ` +
        `last_login, ${disabledColumn}, ${statusColumns}, ` +
        `(SELECT json_group_array(json_object('id', groups.id, ` +
        `'name', groups.name, 'created_at', groups.created_at)) ` +
        `FROM user_groups JOIN groups ON groups.id = user_groups.group_id ` +
        `WHERE user_groups.user_id = users.id) AS groups_json ` +
        `FROM users WHERE id = ?`,
    )
    .get(userId) as AdminUserRow | undefined;
  if (!row) throw new AdminError("user_not_found", 404, "user not found");
  return {
    ...adminUserFromRow(database, row),
    account_status: accountStatus(database, row.id),
  };
}

/** Converts an administrative user row into the stable public view. */
export function adminUserFromRow(
  database: Database.Database,
  row: AdminUserRow,
): UserView {
  let role: Role;
  try {
    role = normalizeRole(row.role);
  } catch {
    throw new AdminError(
      "admin_identity_inconsistent",
      503,
      "stored user role is invalid",
    );
  }
  const status =
    row.disabled_at !== null
      ? "disabled"
      : row.account_status === "suspended" ||
          row.account_status === "banned"
        ? row.account_status
        : "active";
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role,
    external_provider: row.external_provider,
    created_at: row.created_at,
    last_login: row.last_login,
    groups: parseAdminGroups(row.groups_json ?? "[]"),
    disabled_at: row.disabled_at,
    account_status: status,
    status_reason: row.status_reason ?? null,
    status_changed_at: row.status_changed_at ?? null,
    status_expires_at: row.status_expires_at ?? null,
  };
}
