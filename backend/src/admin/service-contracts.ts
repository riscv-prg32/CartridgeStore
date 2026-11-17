import type { AccountStatus } from "../auth/account-state.js";
import type { Role } from "../auth/principal.js";

/** Audit identity attached to an administrative mutation. */
export interface AdminMutationContext {
  readonly actorUserId: number;
  readonly requestId: string;
}

/** Input for creating a local administrative user. */
export interface UserCreateInput {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly passwordConfirm?: string;
  readonly role?: string;
  readonly groupIds?: readonly number[];
}

/** Patch input for an existing local user. */
export interface UserUpdateInput {
  readonly username?: string;
  readonly email?: string;
  readonly password?: string;
  readonly passwordConfirm?: string;
}

/** Public user representation returned by administrative reads. */
export interface UserView {
  readonly id: number;
  readonly username: string;
  readonly email: string;
  readonly role: Role;
  readonly external_provider: string | null;
  readonly created_at: string;
  readonly last_login: string | null;
  readonly groups: readonly GroupView[];
  readonly disabled_at: string | null;
  readonly account_status: AccountStatus;
  readonly status_reason: string | null;
  readonly status_changed_at: string | null;
  readonly status_expires_at: string | null;
}

/** Public group representation returned by administrative reads. */
export interface GroupView {
  readonly id: number;
  readonly name: string;
  readonly created_at: string;
  readonly user_count: number;
}
