import type Database from "better-sqlite3";

import { hasAccountStateColumn, isAccountEnabled } from "./account-state.js";
import { lookupApiToken, type ApiTokenLookup, hashApiToken } from "./tokens.js";

export const ROLE_LEVELS = {
  reader: 0,
  user: 1,
  player: 1,
  publisher: 2,
  admin: 3
} as const;

export type Role = keyof typeof ROLE_LEVELS;

export interface Principal {
  readonly authenticated: boolean;
  readonly id: number | null;
  readonly name: string;
  readonly username: string;
  readonly email: string;
  readonly role: Role;
  readonly groups: readonly string[];
  readonly authMethod: "anonymous" | "session" | "bearer" | "legacy";
  readonly tokenHash?: string;
}

export const ANONYMOUS: Principal = {
  authenticated: false,
  id: null,
  name: "anonymous",
  username: "anonymous",
  email: "",
  role: "reader",
  groups: [],
  authMethod: "anonymous"
};

export function normalizeRole(value: unknown): Role {
  const role = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).trim().toLowerCase()
    : "";
  if (!(role in ROLE_LEVELS)) throw new Error("unsupported role");
  return role as Role;
}

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_LEVELS[actual] >= ROLE_LEVELS[required];
}

export function principalToJson(principal: Principal): Record<string, unknown> {
  return {
    id: principal.id,
    name: principal.name,
    username: principal.username,
    email: principal.email,
    role: principal.role,
    groups: [...principal.groups],
    authenticated: principal.authenticated
  };
}

function groupsForUser(sqlite: Database.Database, userId: number): string[] {
  return (sqlite.prepare(
    `SELECT groups.name FROM user_groups
     JOIN groups ON groups.id = user_groups.group_id
     WHERE user_groups.user_id = ? ORDER BY groups.name`
  ).all(userId) as Array<{ name: string }>).map((group) => group.name);
}

export function principalFromUserRow(
  sqlite: Database.Database,
  row: {
    id: number;
    username: string;
    display_name?: string | null;
    email: string;
    role: string;
    external_provider?: string | null;
    disabled_at?: string | null;
    account_status?: string | null;
  },
  authMethod: Principal["authMethod"],
  tokenHash?: string
): Principal {
  if ((row.disabled_at !== undefined && row.disabled_at !== null) || row.account_status === "suspended" || row.account_status === "banned" || row.account_status === "disabled") return ANONYMOUS;
  const role = normalizeRole(row.role);
  return {
    authenticated: true,
    id: row.id,
    name: row.display_name?.trim() || row.username,
    username: row.username,
    email: row.email,
    role,
    groups: groupsForUser(sqlite, row.id),
    authMethod,
    ...(tokenHash ? { tokenHash } : {})
  };
}

export function loadPrincipalById(sqlite: Database.Database, userId: number, authMethod: Principal["authMethod"]): Principal {
  const columns = new Set((sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((item) => item.name));
  const displayName = columns.has("display_name") ? ", display_name" : "";
  const state = hasAccountStateColumn(sqlite) ? ", disabled_at" : "";
  const status = columns.has("account_status") ? ", account_status" : "";
  const row = sqlite.prepare(
    "SELECT id, username" +
    displayName +
    ", email, role, external_provider" +
    state +
    status +
    " FROM users WHERE id = ?",
  ).get(userId) as {
    id: number;
    username: string;
    display_name?: string | null;
    email: string;
    role: string;
    external_provider?: string | null;
    disabled_at?: string | null;
    account_status?: string | null;
  } | undefined;
  return row ? principalFromUserRow(sqlite, row, authMethod) : ANONYMOUS;
}

export function authenticateBearer(sqlite: Database.Database, token: string, writable: boolean): Principal {
  const lookup: ApiTokenLookup | null = lookupApiToken(sqlite, token);
  if (!lookup) return ANONYMOUS;
  if (lookup.owner.id !== null && !isAccountEnabled(sqlite, lookup.owner.id)) return ANONYMOUS;
  if (writable) {
    sqlite.prepare("UPDATE api_tokens SET last_used = datetime('now') WHERE token_hash = ?").run(lookup.tokenHash);
  }
  return {
    ...lookup.owner,
    authenticated: true,
    name: lookup.owner.displayName || lookup.owner.username,
    username: lookup.owner.username,
    role: normalizeRole(lookup.owner.role),
    groups: lookup.owner.groups,
    authMethod: "bearer",
    tokenHash: hashApiToken(token)
  };
}

export function authorizedForRole(principal: Principal, required: Role): boolean {
  return principal.authenticated && roleAtLeast(principal.role, required);
}

export function authorizedForGroup(principal: Principal, group: string): boolean {
  return principal.authenticated && principal.groups.includes(group.trim().toLowerCase());
}
