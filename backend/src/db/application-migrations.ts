import type Database from "better-sqlite3";

/**
 * Additive application tables shared by the disposable canonical writer and
 * the isolated authentication writer.  This deliberately lives outside the
 * compatibility Drizzle snapshot: the legacy snapshot is an API/schema ABI
 * and must remain byte-for-byte compatible with the established database
 * contract.
 */
export function applyApplicationMigrations(database: Database.Database): void {
  // Runtime administration is intentionally additive.  The legacy
  // store_settings table remains available for the public compatibility ABI;
  // typed settings and audit history live in their own tables so a future
  // Fastify deployment does not have to infer types from legacy strings.
  if (hasTable(database, "users") && hasTable(database, "store_settings")) {
    addColumn(database, "users", "display_name", "TEXT NOT NULL DEFAULT ''");
    addColumn(database, "users", "account_status", "TEXT NOT NULL DEFAULT 'active'");
    addColumn(database, "users", "status_reason", "TEXT");
    addColumn(database, "users", "status_actor_user_id", "INTEGER");
    addColumn(database, "users", "status_changed_at", "TEXT");
    addColumn(database, "users", "status_expires_at", "TEXT");
    database.exec(`
      CREATE TABLE IF NOT EXISTS application_settings (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        value_type TEXT NOT NULL CHECK (value_type IN ('string', 'boolean', 'number', 'string[]', 'enum', 'secret_ref')),
        category TEXT NOT NULL,
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'admin', 'secret')),
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS admin_audit_events (
        event_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        actor_user_id INTEGER,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('attempted', 'committed', 'failed', 'rejected')),
        summary_json TEXT NOT NULL DEFAULT '{}',
        request_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_audit_events_time_idx ON admin_audit_events(timestamp, event_id);
      CREATE TABLE IF NOT EXISTS setup_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        state TEXT NOT NULL CHECK (state IN ('INFRASTRUCTURE_NOT_READY', 'INSTALLATION_REQUIRED', 'INSTALLATION_IN_PROGRESS', 'INSTALLATION_COMPLETE', 'INSTALLATION_RECOVERY_REQUIRED')),
        completed_steps_json TEXT NOT NULL DEFAULT '[]',
        admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        recovery_reason TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO setup_state(singleton_id, state, completed_steps_json, admin_user_id, completed_at, updated_at)
      SELECT 1,
        CASE
          WHEN EXISTS (SELECT 1 FROM users WHERE role = 'admin') OR EXISTS (SELECT 1 FROM store_settings WHERE key = 'auth_bootstrap_completed' AND value = 'true') THEN 'INSTALLATION_COMPLETE'
          WHEN EXISTS (SELECT 1 FROM users) THEN 'INSTALLATION_RECOVERY_REQUIRED'
          ELSE 'INSTALLATION_REQUIRED'
        END,
        CASE
          WHEN EXISTS (SELECT 1 FROM users WHERE role = 'admin') OR EXISTS (SELECT 1 FROM store_settings WHERE key = 'auth_bootstrap_completed' AND value = 'true') THEN '["admin"]'
          ELSE '[]'
        END,
        (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1),
        CASE WHEN EXISTS (SELECT 1 FROM users WHERE role = 'admin') OR EXISTS (SELECT 1 FROM store_settings WHERE key = 'auth_bootstrap_completed' AND value = 'true') THEN datetime('now') ELSE NULL END,
        datetime('now');
      CREATE TABLE IF NOT EXISTS catalog_moderation (
        moderation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        cartridge_id TEXT NOT NULL,
        version TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('hidden', 'unpublished', 'restored')),
        reason TEXT NOT NULL DEFAULT '',
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS catalog_moderation_lookup_idx ON catalog_moderation(cartridge_id, version, active, created_at DESC);
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL,
        signature_counter INTEGER NOT NULL DEFAULT 0 CHECK(signature_counter >= 0),
        device_type TEXT NOT NULL CHECK(device_type IN ('singleDevice', 'multiDevice')),
        backed_up INTEGER NOT NULL DEFAULT 0 CHECK(backed_up IN (0, 1)),
        transports_json TEXT NOT NULL DEFAULT '[]',
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx ON webauthn_credentials(user_id, revoked_at, created_at);
      CREATE TABLE IF NOT EXISTS webauthn_challenges (
        challenge_id TEXT PRIMARY KEY,
        ceremony TEXT NOT NULL CHECK(ceremony IN ('registration', 'authentication')),
        challenge TEXT NOT NULL UNIQUE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry_idx ON webauthn_challenges(expires_at, consumed_at);
    `);
  }
  if (hasTable(database, "submissions")) database.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id, used_at, expires_at);
    CREATE TABLE IF NOT EXISTS publisher_drafts (
      draft_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('draft', 'submitting', 'submitted', 'abandoned')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      bundle_path TEXT,
      source_submission_id INTEGER,
      submitted_submission_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      FOREIGN KEY (source_submission_id) REFERENCES submissions(submission_id) ON DELETE RESTRICT,
      FOREIGN KEY (submitted_submission_id) REFERENCES submissions(submission_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS publisher_drafts_owner_idx
      ON publisher_drafts(user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS publisher_drafts_source_idx
      ON publisher_drafts(source_submission_id);
  `);
  if (hasTable(database, "submissions")) {
    addColumn(database, "registration_tokens", "username", "TEXT");
    addColumn(database, "registration_tokens", "password_hash", "TEXT");
    addColumn(database, "submissions", "revision_of_submission_id", "INTEGER REFERENCES submissions(submission_id) ON DELETE RESTRICT");
    addColumn(database, "submissions", "revision_number", "INTEGER NOT NULL DEFAULT 1");
    database.exec("CREATE INDEX IF NOT EXISTS submissions_revision_idx ON submissions(revision_of_submission_id, revision_number)");
  }
}

function hasTable(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function addColumn(database: Database.Database, table: string, column: string, definition: string): void {
  if (!hasTable(database, table)) return;
  const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  database.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
