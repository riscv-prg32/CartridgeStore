import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { AdminAuditLog } from "./audit.js";
import { AdminGroupService } from "./group-service.js";
import { getAdminAudit, listAdminAudit, listAdminRoles } from "./read-model.js";
import { AdminUserService } from "./user-service.js";
import type {
  AdminMutationContext,
  GroupView,
  UserCreateInput,
  UserUpdateInput,
  UserView,
} from "./service-contracts.js";
import type { AdminUserListOptions } from "./read-model.js";

export type {
  AdminMutationContext,
  GroupView,
  UserCreateInput,
  UserUpdateInput,
  UserView,
} from "./service-contracts.js";

type DatabaseSource = Database.Database | (() => Database.Database);
export { AdminError } from "./errors.js";

/** Compatibility facade for administrative identity and group operations. */
export class AdminIdentityService {
  private readonly source: DatabaseSource;
  private readonly audit: AdminAuditLog;
  private readonly groups: AdminGroupService;
  private readonly users: AdminUserService;

  constructor(options: {
    readonly config: BackendConfig;
    readonly database: DatabaseSource;
    readonly writableDatabase: Database.Database | null;
    readonly audit?: AdminAuditLog;
  }) {
    this.source = options.database;
    this.audit = options.audit ?? new AdminAuditLog(options.config);
    this.groups = new AdminGroupService({
      config: options.config,
      database: options.database,
      writableDatabase: options.writableDatabase,
      audit: this.audit,
    });
    this.users = new AdminUserService({
      database: options.database,
      writableDatabase: options.writableDatabase,
      audit: this.audit,
      groups: this.groups,
    });
  }

  /** Lists administrative users. */
  listUsers(options: AdminUserListOptions): {
    readonly users: readonly UserView[];
    readonly page: number;
    readonly limit: number;
    readonly total: number;
  } {
    return this.users.listUsers(options);
  }

  /** Reads one administrative user. */
  getUser(userId: number): UserView {
    return this.users.getUser(userId);
  }

  /** Creates one local administrative user. */
  createUser(
    input: UserCreateInput,
    context: AdminMutationContext,
  ): UserView {
    return this.users.createUser(input, context);
  }

  /** Updates one local administrative user. */
  updateUser(
    userId: number,
    input: UserUpdateInput,
    context: AdminMutationContext,
  ): UserView {
    return this.users.updateUser(userId, input, context);
  }

  /** Changes one user's role. */
  setRole(
    userId: number,
    roleValue: unknown,
    context: AdminMutationContext,
  ): UserView {
    return this.users.setRole(userId, roleValue, context);
  }

  /** Enables or disables one user account. */
  setDisabled(
    userId: number,
    disabledValue: unknown,
    context: AdminMutationContext,
  ): UserView {
    return this.users.setDisabled(userId, disabledValue, context);
  }

  /** Changes one user's account status. */
  setStatus(
    userId: number,
    statusValue: unknown,
    reasonValue: unknown,
    expiresValue: unknown,
    context: AdminMutationContext,
  ): UserView {
    return this.users.setStatus(
      userId,
      statusValue,
      reasonValue,
      expiresValue,
      context,
    );
  }

  /** Replaces one user's group membership. */
  replaceGroups(
    userId: number,
    value: unknown,
    context: AdminMutationContext,
  ): UserView {
    return this.users.replaceGroups(userId, value, context);
  }

  /** Deletes one local user. */
  deleteUser(
    userId: number,
    context: AdminMutationContext,
  ): { readonly user_id: number } {
    return this.users.deleteUser(userId, context);
  }

  /** Lists administrative groups. */
  listGroups(limit: number): {
    readonly groups: readonly GroupView[];
    readonly limit: number;
  } {
    return this.groups.listGroups(limit);
  }

  /** Creates one administrative group. */
  createGroup(
    nameValue: unknown,
    context: AdminMutationContext,
  ): GroupView {
    return this.groups.createGroup(nameValue, context);
  }

  /** Renames one administrative group. */
  renameGroup(
    groupId: number,
    nameValue: unknown,
    context: AdminMutationContext,
  ): GroupView {
    return this.groups.renameGroup(groupId, nameValue, context);
  }

  /** Deletes one administrative group. */
  deleteGroup(
    groupId: number,
    context: AdminMutationContext,
  ): { readonly group_id: number } {
    return this.groups.deleteGroup(groupId, context);
  }

  /** Lists the available administrative roles. */
  roles(): readonly Record<string, unknown>[] {
    return listAdminRoles(this.database);
  }

  /** Lists bounded administrative audit events. */
  listAudit(limitValue = 100): {
    readonly events: readonly Record<string, unknown>[];
    readonly limit: number;
  } {
    return listAdminAudit(this.database, limitValue);
  }

  /** Reads one administrative audit event by stable identifier. */
  getAudit(eventId: string): Record<string, unknown> | null {
    return getAdminAudit(this.database, eventId);
  }

  private get database(): Database.Database {
    return typeof this.source === "function" ? this.source() : this.source;
  }
}
