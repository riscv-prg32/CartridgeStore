import type Database from "better-sqlite3";

/** Returns the optional email domain configured for new registrations. */
export function registrationDomain(database: Database.Database): string {
  const setting = database
    .prepare(
      "SELECT value FROM store_settings WHERE key = 'auth_require_email_domain'",
    )
    .get() as { value?: string } | undefined;
  return typeof setting?.value === "string"
    ? setting.value.trim().toLowerCase().replace(/^@+/, "")
    : "";
}

/** Applies the idempotent schema additions used by registration and recovery. */
export function ensureAuthWorkflowSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
      ON password_reset_tokens(user_id, used_at, expires_at);
  `);
  for (const [column, definition] of [
    ["username", "TEXT"],
    ["password_hash", "TEXT"],
  ] as const) {
    const present = (
      database
        .prepare("PRAGMA table_info(registration_tokens)")
        .all() as Array<{ name: string }>
    ).some((row) => row.name === column);
    if (!present) {
      database.exec(
        `ALTER TABLE registration_tokens ADD COLUMN "${column}" ${definition}`,
      );
    }
  }
}
