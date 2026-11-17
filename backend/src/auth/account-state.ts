import type Database from "better-sqlite3";

import { hasFederationTable } from "../db/federation-migrations.js";

export type AccountStatus = "active" | "suspended" | "banned" | "disabled";
export type AccountState = "enabled" | "disabled";

export function hasAccountStateColumn(database: Database.Database): boolean {
  return (database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>)
    .some((column) => column.name === "disabled_at");
}

export function accountDisabledAt(database: Database.Database, userId: number): string | null {
  if (!hasAccountStateColumn(database)) return null;
  const row = database.prepare("SELECT disabled_at FROM users WHERE id = ?").get(userId) as { disabled_at?: string | null } | undefined;
  return row?.disabled_at ?? null;
}

export function hasAccountStatusColumn(database: Database.Database): boolean {
  return (database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>)
    .some((column) => column.name === "account_status");
}

export function accountStatus(database: Database.Database, userId: number): AccountStatus {
  const disabled = accountDisabledAt(database, userId);
  if (disabled !== null) return "disabled";
  if (!hasAccountStatusColumn(database)) return "active";
  const row = database.prepare("SELECT account_status, status_expires_at FROM users WHERE id = ?").get(userId) as { account_status?: string | null; status_expires_at?: string | null } | undefined;
  const value = row?.account_status;
  if (value === "suspended" && row?.status_expires_at && Date.parse(row.status_expires_at) <= Date.now()) return "active";
  return value === "suspended" || value === "banned" || value === "disabled" ? value : "active";
}

export function isAccountEnabled(database: Database.Database, userId: number): boolean {
  return accountStatus(database, userId) === "active";
}

export function accountState(database: Database.Database, userId: number): AccountState {
  return isAccountEnabled(database, userId) ? "enabled" : "disabled";
}

export function invalidateAccountAccess(database: Database.Database, userId: number, now = Date.now()): void {
  database.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(userId);
  if (hasFederationTable(database, "auth_sessions")) {
    database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  }
  const key = "auth_revoked_before:" + userId;
  const current = Number((database.prepare("SELECT value FROM store_settings WHERE key = ?").get(key) as { value?: string } | undefined)?.value);
  const next = Math.max(now, Number.isSafeInteger(current) && current >= 0 ? current + 1 : 0);
  database.prepare(
    "INSERT INTO store_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(next));
}
