import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { AdminAuditLog } from "./audit.js";
import {
  normalizeAdminGroupName,
  positiveAdminId,
} from "./codecs.js";
import { AdminError } from "./errors.js";
import { runAdminMutation } from "./mutation-runner.js";
import { listAdminGroups } from "./read-model.js";
import type {
  AdminMutationContext,
  GroupView,
} from "./service-contracts.js";

type DatabaseSource = Database.Database | (() => Database.Database);

/** Owns administrative group CRUD and user-group membership persistence. */
export class AdminGroupService {
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

  /** Lists groups after confirming the protected editors group exists. */
  listGroups(limit: number): {
    readonly groups: readonly GroupView[];
    readonly limit: number;
  } {
    const database = this.database;
    this.ensureEditors(database);
    return listAdminGroups(database, limit);
  }

  /** Creates one administrative group. */
  createGroup(
    nameValue: unknown,
    context: AdminMutationContext,
  ): GroupView {
    const name = normalizeAdminGroupName(nameValue);
    return this.mutate(
      context,
      "group.create",
      "group",
      "pending",
      (database) => {
        this.ensureEditors(database);
        const result = database
          .prepare("INSERT INTO groups(name) VALUES (?)")
          .run(name);
        return this.group(database, Number(result.lastInsertRowid));
      },
    );
  }

  /** Renames a non-protected administrative group. */
  renameGroup(
    groupId: number,
    nameValue: unknown,
    context: AdminMutationContext,
  ): GroupView {
    const id = positiveAdminId(groupId, "group_id");
    const name = normalizeAdminGroupName(nameValue);
    return this.mutate(
      context,
      "group.rename",
      "group",
      String(id),
      (database) => {
        this.ensureEditors(database);
        const current = this.group(database, id);
        if (current.name === "editors") {
          throw new AdminError(
            "protected_group",
            409,
            "the editors group cannot be renamed",
          );
        }
        database
          .prepare("UPDATE groups SET name = ? WHERE id = ?")
          .run(name, id);
        return this.group(database, id);
      },
    );
  }

  /** Deletes a non-protected administrative group and its memberships. */
  deleteGroup(
    groupId: number,
    context: AdminMutationContext,
  ): { readonly group_id: number } {
    const id = positiveAdminId(groupId, "group_id");
    return this.mutate(
      context,
      "group.delete",
      "group",
      String(id),
      (database) => {
        this.ensureEditors(database);
        const current = this.group(database, id);
        if (current.name === "editors") {
          throw new AdminError(
            "protected_group",
            409,
            "the editors group cannot be deleted",
          );
        }
        database
          .prepare("DELETE FROM user_groups WHERE group_id = ?")
          .run(id);
        database.prepare("DELETE FROM groups WHERE id = ?").run(id);
        return { group_id: id };
      },
    );
  }

  /** Ensures that every requested group exists. */
  assertGroups(
    database: Database.Database,
    groupIds: readonly number[],
  ): void {
    if (!groupIds.length) return;
    const placeholders = groupIds.map(() => "?").join(",");
    const rows = database
      .prepare(`SELECT id FROM groups WHERE id IN (${placeholders})`)
      .all(...groupIds) as Array<{ id: number }>;
    if (rows.length !== groupIds.length) {
      throw new AdminError(
        "group_not_found",
        404,
        "one or more groups do not exist",
      );
    }
  }

  /** Replaces all memberships for one user. */
  setGroups(
    database: Database.Database,
    userId: number,
    groupIds: readonly number[],
  ): void {
    database.prepare("DELETE FROM user_groups WHERE user_id = ?").run(userId);
    const insert = database.prepare(
      "INSERT INTO user_groups(user_id, group_id) VALUES (?, ?)",
    );
    for (const groupId of groupIds) insert.run(userId, groupId);
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

  private group(database: Database.Database, groupId: number): GroupView {
    const row = database
      .prepare(
        `SELECT groups.id, groups.name, groups.created_at,
                COUNT(user_groups.user_id) AS user_count
           FROM groups
           LEFT JOIN user_groups ON user_groups.group_id = groups.id
          WHERE groups.id = ?
          GROUP BY groups.id`,
      )
      .get(groupId) as GroupView | undefined;
    if (!row) throw new AdminError("group_not_found", 404, "group not found");
    return row;
  }
}
