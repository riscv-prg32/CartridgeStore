import type Database from "better-sqlite3";

import { markRevokedBefore } from "../auth/revocation.js";
import {
  hasAccountStateColumn,
  hasAccountStatusColumn,
  invalidateAccountAccess,
} from "../auth/account-state.js";
import {
  generateWerkzeugScryptHash,
  validatePassword,
} from "../auth/service.js";
import type { AdminAuditLog } from "./audit.js";
import {
  normalizeAdminEmail,
  normalizeAdminGroupIds,
  normalizeAdminRole,
  normalizeAdminUsername,
  positiveAdminId,
} from "./codecs.js";
import { AdminError } from "./errors.js";
import type { AdminGroupService } from "./group-service.js";
import { runAdminMutation } from "./mutation-runner.js";
import { listAdminUsers } from "./read-model.js";
import type { AdminUserListOptions } from "./read-model.js";
import { readAdminUser } from "./user-view.js";
import type {
  AdminMutationContext,
  UserCreateInput,
  UserUpdateInput,
  UserView,
} from "./service-contracts.js";

type DatabaseSource = Database.Database | (() => Database.Database);

/** Owns local-user mutations and their account-access invariants. */
export class AdminUserService {
  private readonly source: DatabaseSource;
  private readonly writable: Database.Database | null;
  private readonly audit: AdminAuditLog;

  constructor(options: {
    readonly database: DatabaseSource;
    readonly writableDatabase: Database.Database | null;
    readonly audit: AdminAuditLog;
    readonly groups: AdminGroupService;
  }) {
    this.source = options.database;
    this.writable = options.writableDatabase;
    this.audit = options.audit;
    this.groups = options.groups;
  }

  private readonly groups: AdminGroupService;

  /** Lists administrative users through the existing read model. */
  listUsers(options: AdminUserListOptions): {
    readonly users: readonly UserView[];
    readonly page: number;
    readonly limit: number;
    readonly total: number;
  } {
    return listAdminUsers(this.database, options);
  }

  /** Reads one administrative user. */
  getUser(userId: number): UserView {
    return readAdminUser(this.database, positiveAdminId(userId, "user_id"));
  }

  /** Creates one local user and assigns its initial groups. */
  createUser(
    input: UserCreateInput,
    context: AdminMutationContext,
  ): UserView {
    const username = normalizeAdminUsername(input.username);
    const email = normalizeAdminEmail(input.email);
    if (typeof input.password !== "string" || !input.password) {
      throw new AdminError("invalid_password", 400, "password is required");
    }
    validatePassword(input.password, input.passwordConfirm ?? input.password);
    const role = input.role === undefined ? "user" : normalizeAdminRole(input.role);
    const groupIds = normalizeAdminGroupIds(input.groupIds);
    const passwordHash = generateWerkzeugScryptHash(input.password);
    return this.mutate(
      context,
      "user.create",
      "user",
      "pending",
      (database) => {
        this.ensureEditors(database);
        this.groups.assertGroups(database, groupIds);
        const result = database
          .prepare(
            "INSERT INTO users(username, email, password_hash, role) " +
              "VALUES (?, ?, ?, ?)",
          )
          .run(username, email, passwordHash, role);
        const userId = Number(result.lastInsertRowid);
        this.groups.setGroups(database, userId, groupIds);
        return readAdminUser(database, userId);
      },
    );
  }

  /** Updates mutable local-user identity fields and optionally the password. */
  updateUser(
    userId: number,
    input: UserUpdateInput,
    context: AdminMutationContext,
  ): UserView {
    const id = positiveAdminId(userId, "user_id");
    if (
      input.username === undefined &&
      input.email === undefined &&
      input.password === undefined
    ) {
      throw new AdminError("empty_user_update", 400, "user update is empty");
    }
    const username =
      input.username === undefined
        ? undefined
        : normalizeAdminUsername(input.username);
    const email =
      input.email === undefined
        ? undefined
        : normalizeAdminEmail(input.email);
    if (input.password !== undefined) {
      if (!input.password) {
        throw new AdminError(
          "invalid_password",
          400,
          "password must not be empty",
        );
      }
      validatePassword(input.password, input.passwordConfirm ?? input.password);
    }
    const passwordHash =
      input.password === undefined
        ? undefined
        : generateWerkzeugScryptHash(input.password);
    return this.mutate(
      context,
      "user.update",
      "user",
      String(id),
      (database) => {
        this.ensureEditors(database);
        readAdminUser(database, id);
        const fields: string[] = [];
        const values: string[] = [];
        if (username !== undefined) {
          fields.push("username = ?");
          values.push(username);
        }
        if (email !== undefined) {
          fields.push("email = ?");
          values.push(email);
        }
        if (passwordHash !== undefined) {
          fields.push("password_hash = ?");
          values.push(passwordHash);
        }
        values.push(String(id));
        database
          .prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`)
          .run(...values);
        if (passwordHash !== undefined) {
          database.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(id);
          markRevokedBefore(database, id);
        }
        return readAdminUser(database, id);
      },
    );
  }

  /** Changes a role while preserving the final-administrator invariant. */
  setRole(
    userId: number,
    roleValue: unknown,
    context: AdminMutationContext,
  ): UserView {
    const id = positiveAdminId(userId, "user_id");
    const role = normalizeAdminRole(roleValue);
    return this.mutate(
      context,
      "user.role.update",
      "user",
      String(id),
      (database) => {
        this.ensureEditors(database);
        const current = readAdminUser(database, id);
        if (id === context.actorUserId && role !== "admin") {
          throw new AdminError(
            "self_demotion_forbidden",
            409,
            "administrators cannot demote themselves",
          );
        }
        if (current.role === "admin" && role !== "admin") {
          const count = Number(
            (
              database
                .prepare(
                  "SELECT COUNT(*) AS count FROM users " +
                    "WHERE role = 'admin'",
                )
                .get() as { count: number }
            ).count,
          );
          if (count <= 1) {
            throw new AdminError(
              "final_administrator_required",
              409,
              "at least one administrator must remain",
            );
          }
        }
        if (current.role !== role) {
          database.prepare("UPDATE users SET role = ? WHERE id = ?").run(
            role,
            id,
          );
          database.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(id);
          markRevokedBefore(database, id);
        }
        return readAdminUser(database, id);
      },
    );
  }

  /** Enables or disables an account while protecting administrators. */
  setDisabled(
    userId: number,
    disabledValue: unknown,
    context: AdminMutationContext,
  ): UserView {
    if (typeof disabledValue !== "boolean") {
      throw new AdminError(
        "invalid_account_state",
        400,
        "disabled must be boolean",
      );
    }
    const id = positiveAdminId(userId, "user_id");
    return this.mutate(
      context,
      disabledValue
        ? "user.account.disabled"
        : "user.account.enabled",
      "user",
      String(id),
      (database) => {
        if (!hasAccountStateColumn(database)) {
          throw new AdminError(
            "account_state_unavailable",
            503,
            "account state is unavailable",
          );
        }
        this.ensureEditors(database);
        const current = readAdminUser(database, id);
        if (id === context.actorUserId && disabledValue) {
          throw new AdminError(
            "self_disable_forbidden",
            409,
            "administrators cannot disable themselves",
          );
        }
        if (
          current.role === "admin" &&
          disabledValue &&
          current.disabled_at === null
        ) {
          const count = Number(
            (
              database
                .prepare(
                  "SELECT COUNT(*) AS count FROM users " +
                    "WHERE role = 'admin' AND disabled_at IS NULL",
                )
                .get() as { count: number }
            ).count,
          );
          if (count <= 1) {
            throw new AdminError(
              "final_administrator_required",
              409,
              "at least one enabled administrator must remain",
            );
          }
        }
        const next = disabledValue ? new Date().toISOString() : null;
        database
          .prepare("UPDATE users SET disabled_at = ? WHERE id = ?")
          .run(next, id);
        if (disabledValue) invalidateAccountAccess(database, id);
        return readAdminUser(database, id);
      },
    );
  }

  /** Changes account status while preserving access revocation semantics. */
  setStatus(
    userId: number,
    statusValue: unknown,
    reasonValue: unknown,
    expiresValue: unknown,
    context: AdminMutationContext,
  ): UserView {
    if (
      statusValue !== "active" &&
      statusValue !== "suspended" &&
      statusValue !== "banned"
    ) {
      throw new AdminError("invalid_account_status", 400, "status is invalid");
    }
    const status = statusValue;
    let reason: string;
    if (reasonValue === undefined) reason = "";
    else if (typeof reasonValue === "string") reason = reasonValue.trim();
    else {
      throw new AdminError(
        "invalid_status_reason",
        400,
        "reason is invalid",
      );
    }
    if (reason.length > 500) {
      throw new AdminError(
        "invalid_status_reason",
        400,
        "reason is invalid",
      );
    }
    let expiresAt: string | null;
    if (
      expiresValue === undefined ||
      expiresValue === null ||
      expiresValue === ""
    ) {
      expiresAt = null;
    } else if (
      typeof expiresValue === "string" &&
      !Number.isNaN(Date.parse(expiresValue))
    ) {
      expiresAt = new Date(expiresValue).toISOString();
    } else {
      throw new AdminError(
        "invalid_status_expiry",
        400,
        "expires_at is invalid",
      );
    }
    const id = positiveAdminId(userId, "user_id");
    return this.mutate(
      context,
      `user.account.${status}`,
      "user",
      String(id),
      (database) => {
        if (!hasAccountStatusColumn(database)) {
          throw new AdminError(
            "account_status_unavailable",
            503,
            "account status is unavailable",
          );
        }
        this.ensureEditors(database);
        const current = readAdminUser(database, id);
        if (id === context.actorUserId && status !== "active") {
          throw new AdminError(
            "self_status_change_forbidden",
            409,
            "administrators cannot suspend or ban themselves",
          );
        }
        if (
          current.role === "admin" &&
          status !== "active" &&
          current.account_status === "active"
        ) {
          const count = Number(
            (
              database
                .prepare(
                  "SELECT COUNT(*) AS count FROM users " +
                    "WHERE role = 'admin' AND disabled_at IS NULL " +
                    "AND account_status = 'active'",
                )
                .get() as { count: number }
            ).count,
          );
          if (count <= 1) {
            throw new AdminError(
              "final_administrator_required",
              409,
              "at least one active administrator must remain",
            );
          }
        }
        const now = new Date().toISOString();
        database
          .prepare(
            "UPDATE users SET account_status = ?, status_reason = ?, " +
              "status_actor_user_id = ?, status_changed_at = ?, " +
              "status_expires_at = ?, disabled_at = CASE WHEN ? = 'active' " +
              "THEN NULL ELSE disabled_at END WHERE id = ?",
          )
          .run(
            status,
            reason || null,
            context.actorUserId,
            now,
            expiresAt,
            status,
            id,
          );
        if (status !== "active") invalidateAccountAccess(database, id);
        return readAdminUser(database, id);
      },
    );
  }

  /** Replaces user groups and revokes access when membership changes. */
  replaceGroups(
    userId: number,
    value: unknown,
    context: AdminMutationContext,
  ): UserView {
    const id = positiveAdminId(userId, "user_id");
    const groupIds = normalizeAdminGroupIds(value);
    return this.mutate(
      context,
      "user.groups.replace",
      "user",
      String(id),
      (database) => {
        this.ensureEditors(database);
        readAdminUser(database, id);
        this.groups.assertGroups(database, groupIds);
        const before = (
          database
            .prepare(
              "SELECT group_id FROM user_groups WHERE user_id = ? " +
                "ORDER BY group_id",
            )
            .all(id) as Array<{ group_id: number }>
        ).map((row) => row.group_id);
        if (
          before.join(",") !==
          [...groupIds].sort((a, b) => a - b).join(",")
        ) {
          this.groups.setGroups(database, id, groupIds);
          database.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(id);
          markRevokedBefore(database, id);
        }
        return readAdminUser(database, id);
      },
    );
  }

  /** Deletes a user while preserving the final-administrator invariant. */
  deleteUser(
    userId: number,
    context: AdminMutationContext,
  ): { readonly user_id: number } {
    const id = positiveAdminId(userId, "user_id");
    return this.mutate(
      context,
      "user.delete",
      "user",
      String(id),
      (database) => {
        this.ensureEditors(database);
        const current = readAdminUser(database, id);
        if (id === context.actorUserId) {
          throw new AdminError(
            "self_deletion_forbidden",
            409,
            "administrators cannot delete themselves",
          );
        }
        if (current.role === "admin") {
          const count = Number(
            (
              database
                .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
                .get() as { count: number }
            ).count,
          );
          if (count <= 1) {
            throw new AdminError(
              "final_administrator_required",
              409,
              "at least one administrator must remain",
            );
          }
        }
        database.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(id);
        markRevokedBefore(database, id);
        database.prepare("DELETE FROM users WHERE id = ?").run(id);
        return { user_id: id };
      },
    );
  }

  private get database(): Database.Database {
    return typeof this.source === "function" ? this.source() : this.source;
  }

  private ensureEditors(database: Database.Database): void {
    const row = database
      .prepare("SELECT id FROM groups WHERE name = 'editors'")
      .get() as { id?: number } | undefined;
    if (!row?.id) {
      throw new AdminError(
        "admin_identity_inconsistent",
        503,
        "protected editors group is unavailable",
      );
    }
  }

  private mutate<T>(
    context: AdminMutationContext,
    action: string,
    targetType: string,
    targetId: string,
    callback: (database: Database.Database) => T,
  ): T {
    return runAdminMutation({
      writableDatabase: this.writable,
      audit: this.audit,
      context,
      action,
      targetType,
      targetId,
      callback,
    });
  }
}
