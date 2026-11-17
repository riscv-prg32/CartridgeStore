import type Database from "better-sqlite3";

export const AUTH_REVOCATION_PREFIX = "auth_revoked_before:";

function key(userId: number): string {
  return `${AUTH_REVOCATION_PREFIX}${userId}`;
}

export function revokedBefore(database: Database.Database, userId: number): number {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(key(userId)) as { value?: string } | undefined;
  const value = Number(row?.value);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Revocation metadata intentionally uses the existing key/value table. It is
 * not a new schema object: the identity mutation and this marker are committed
 * by the same SQLite transaction.
 */
export function markRevokedBefore(database: Database.Database, userId: number, now = Date.now()): number {
  const next = Math.max(now, revokedBefore(database, userId) + 1);
  database.prepare(
    "INSERT INTO store_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key(userId), String(next));
  return next;
}
