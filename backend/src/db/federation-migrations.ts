import type Database from "better-sqlite3";

export const FEDERATION_SCHEMA_VERSION = 6;
export const FEDERATION_TABLES = [
  "auth_sessions",
  "federation_provider_secrets",
  "federation_providers",
  "federation_replays",
  "federation_schema_migrations",
  "federation_transactions",
  "user_external_identities"
] as const;

export class FederationMigrationError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FederationMigrationError";
  }
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function columnExists(database: Database.Database, table: string, column: string): boolean {
  const escaped = table.replaceAll("\"", "\"\"");
  return (database.prepare("PRAGMA table_info(\"" + escaped + "\")").all() as Array<{ name: string }>)
    .some((item) => item.name === column);
}

function requireLegacyTables(database: Database.Database): void {
  for (const table of ["users", "store_settings"]) {
    if (!tableExists(database, table)) {
      throw new FederationMigrationError("federation_schema_incompatible", "legacy authentication schema is incomplete");
    }
  }
}

function createObjects(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS federation_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS federation_providers (
      provider_id TEXT PRIMARY KEY CHECK(length(provider_id) BETWEEN 1 AND 64),
      protocol TEXT NOT NULL CHECK(protocol IN ('oidc', 'saml')),
      display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
      issuer TEXT NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      client_id TEXT,
      client_auth_method TEXT NOT NULL DEFAULT 'client_secret_basic' CHECK(client_auth_method IN ('client_secret_basic', 'client_secret_post', 'none')),
      discovery_issuer TEXT,
      redirect_uri TEXT,
      scopes_json TEXT,
      client_secret_reference TEXT,
      idp_entity_id TEXT,
      sp_entity_id TEXT,
      acs_url TEXT,
      metadata_reference TEXT,
      trusted_certificate_reference TEXT,
      signing_key_reference TEXT,
      saml_entry_point TEXT,
      saml_name_id_format TEXT,
      saml_idp_certificate_pem TEXT,
      saml_sp_certificate_pem TEXT,
      saml_want_assertions_signed INTEGER NOT NULL DEFAULT 1 CHECK(saml_want_assertions_signed IN (0, 1)),
      saml_want_authn_response_signed INTEGER NOT NULL DEFAULT 1 CHECK(saml_want_authn_response_signed IN (0, 1)),
      saml_sign_authn_requests INTEGER NOT NULL DEFAULT 0 CHECK(saml_sign_authn_requests IN (0, 1)),
      saml_accepted_clock_skew_ms INTEGER NOT NULL DEFAULT 0 CHECK(saml_accepted_clock_skew_ms BETWEEN 0 AND 300000),
      saml_metadata_lifecycle_policy TEXT NOT NULL DEFAULT 'manual' CHECK(saml_metadata_lifecycle_policy IN ('manual')),
      saml_trusted_certificates_json TEXT,
      generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(protocol, issuer)
    );
    CREATE INDEX IF NOT EXISTS federation_providers_enabled_idx
      ON federation_providers(enabled, protocol);
    CREATE TABLE IF NOT EXISTS user_external_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      protocol TEXT NOT NULL CHECK(protocol IN ('oidc', 'saml')),
      provider_id TEXT NOT NULL REFERENCES federation_providers(provider_id) ON DELETE RESTRICT,
      issuer TEXT NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512),
      subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 512),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT,
      unlinked_at TEXT,
      UNIQUE(protocol, issuer, subject)
    );
    CREATE INDEX IF NOT EXISTS user_external_identities_user_idx
      ON user_external_identities(user_id, unlinked_at);
    CREATE INDEX IF NOT EXISTS user_external_identities_provider_idx
      ON user_external_identities(provider_id, protocol, issuer);
    CREATE TABLE IF NOT EXISTS federation_transactions (
      transaction_id TEXT PRIMARY KEY CHECK(length(transaction_id) BETWEEN 43 AND 128),
      protocol TEXT NOT NULL CHECK(protocol IN ('oidc', 'saml')),
      provider_id TEXT NOT NULL REFERENCES federation_providers(provider_id) ON DELETE RESTRICT,
      callback_binding TEXT NOT NULL CHECK(length(callback_binding) BETWEEN 1 AND 160),
      state_hash TEXT NOT NULL CHECK(length(state_hash) = 64),
      nonce_hash TEXT,
      nonce_ciphertext TEXT,
      pkce_verifier_ciphertext TEXT,
      request_id TEXT,
      return_path TEXT NOT NULL CHECK(length(return_path) BETWEEN 1 AND 512),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      provider_generation INTEGER NOT NULL DEFAULT 1 CHECK(provider_generation > 0),
      CHECK(expires_at > created_at)
    );
    CREATE INDEX IF NOT EXISTS federation_transactions_expiry_idx
      ON federation_transactions(expires_at, consumed_at);
    CREATE UNIQUE INDEX IF NOT EXISTS federation_transactions_request_idx
      ON federation_transactions(protocol, provider_id, request_id)
      WHERE request_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS federation_replays (
      protocol TEXT NOT NULL CHECK(protocol IN ('oidc', 'saml')),
      provider_id TEXT NOT NULL REFERENCES federation_providers(provider_id) ON DELETE RESTRICT,
      identifier TEXT NOT NULL CHECK(length(identifier) BETWEEN 1 AND 512),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      PRIMARY KEY(protocol, provider_id, identifier)
    );
    CREATE INDEX IF NOT EXISTS federation_replays_expiry_idx
      ON federation_replays(expires_at);
    CREATE TABLE IF NOT EXISTS federation_provider_secrets (
      provider_id TEXT NOT NULL REFERENCES federation_providers(provider_id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('oidc-client-secret', 'saml-sp-signing-private-key', 'saml-sp-decryption-private-key')),
      encrypted_value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(provider_id, purpose)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id_hash TEXT PRIMARY KEY CHECK(length(id_hash) = 64),
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      csrf_token_ciphertext TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      reauthenticated_at INTEGER,
      CHECK(expires_at > created_at)
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
      ON auth_sessions(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
      ON auth_sessions(expires_at);
  `);
}

function validateObjects(database: Database.Database): void {
  for (const table of FEDERATION_TABLES) {
    if (!tableExists(database, table)) {
      throw new FederationMigrationError("federation_schema_incomplete", "federation schema migration is incomplete");
    }
  }
  if (!columnExists(database, "users", "disabled_at")) {
    throw new FederationMigrationError("federation_schema_incomplete", "account state column is missing");
  }
  if (!columnExists(database, "federation_providers", "client_auth_method")) {
    throw new FederationMigrationError("federation_schema_incomplete", "provider client authentication method is missing");
  }
  for (const column of [
    "saml_entry_point",
    "saml_name_id_format",
    "saml_idp_certificate_pem",
    "saml_sp_certificate_pem",
    "saml_want_assertions_signed",
    "saml_want_authn_response_signed",
    "saml_sign_authn_requests",
    "saml_accepted_clock_skew_ms",
    "saml_metadata_lifecycle_policy"
  ]) {
    if (!columnExists(database, "federation_providers", column)) {
      throw new FederationMigrationError("federation_schema_incomplete", "SAML provider configuration is missing");
    }
  }
  for (const column of ["saml_trusted_certificates_json", "generation"]) {
    if (!columnExists(database, "federation_providers", column)) {
      throw new FederationMigrationError("federation_schema_incomplete", "federation provider lifecycle configuration is missing");
    }
  }
  if (!columnExists(database, "federation_transactions", "provider_generation")) {
    throw new FederationMigrationError("federation_schema_incomplete", "federation transaction lifecycle binding is missing");
  }
}

export function applyFederationMigrations(database: Database.Database): void {
  requireLegacyTables(database);
  const current = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (!Number.isSafeInteger(current) || current < 0 || current > FEDERATION_SCHEMA_VERSION) {
    throw new FederationMigrationError("federation_schema_version_unsupported", "federation schema version is unsupported");
  }
  try {
    database.exec("BEGIN IMMEDIATE");
    if (current < 1) {
      if (!columnExists(database, "users", "disabled_at")) {
        database.exec("ALTER TABLE users ADD COLUMN disabled_at TEXT");
      }
      createObjects(database);
      database.prepare(
        "INSERT OR IGNORE INTO federation_schema_migrations(version, name) VALUES (1, ?)"
      ).run("federated-identity-foundation");
    } else {
      createObjects(database);
    }
    if (current < 2) {
      if (!columnExists(database, "federation_providers", "client_auth_method")) {
        database.exec("ALTER TABLE federation_providers ADD COLUMN client_auth_method TEXT NOT NULL DEFAULT 'client_secret_basic' CHECK(client_auth_method IN ('client_secret_basic', 'client_secret_post', 'none'))");
      }
      database.prepare(
        "INSERT OR IGNORE INTO federation_schema_migrations(version, name) VALUES (2, ?)"
      ).run("oidc-client-authentication-method");
    }
    if (current < 3) {
      if (!columnExists(database, "federation_transactions", "nonce_ciphertext")) {
        database.exec("ALTER TABLE federation_transactions ADD COLUMN nonce_ciphertext TEXT");
      }
      database.prepare(
        "INSERT OR IGNORE INTO federation_schema_migrations(version, name) VALUES (3, ?)"
      ).run("oidc-nonce-confidentiality");
    }
    if (current < 4) {
      const columns: readonly [string, string][] = [
        ["saml_entry_point", "TEXT"],
        ["saml_name_id_format", "TEXT"],
        ["saml_idp_certificate_pem", "TEXT"],
        ["saml_sp_certificate_pem", "TEXT"],
        ["saml_want_assertions_signed", "INTEGER NOT NULL DEFAULT 1 CHECK(saml_want_assertions_signed IN (0, 1))"],
        ["saml_want_authn_response_signed", "INTEGER NOT NULL DEFAULT 1 CHECK(saml_want_authn_response_signed IN (0, 1))"],
        ["saml_sign_authn_requests", "INTEGER NOT NULL DEFAULT 0 CHECK(saml_sign_authn_requests IN (0, 1))"],
        ["saml_accepted_clock_skew_ms", "INTEGER NOT NULL DEFAULT 0 CHECK(saml_accepted_clock_skew_ms BETWEEN 0 AND 300000)"],
        ["saml_metadata_lifecycle_policy", "TEXT NOT NULL DEFAULT 'manual' CHECK(saml_metadata_lifecycle_policy IN ('manual'))"]
      ];
      for (const [name, definition] of columns) {
        if (!columnExists(database, "federation_providers", name)) {
          database.exec(`ALTER TABLE federation_providers ADD COLUMN ${name} ${definition}`);
        }
      }
      database.prepare(
        "INSERT OR IGNORE INTO federation_schema_migrations(version, name) VALUES (4, ?)"
      ).run("saml-service-provider-configuration");
    }
    if (current < 5) {
      if (!columnExists(database, "federation_providers", "saml_trusted_certificates_json")) {
        database.exec("ALTER TABLE federation_providers ADD COLUMN saml_trusted_certificates_json TEXT");
      }
      if (!columnExists(database, "federation_providers", "generation")) {
        database.exec("ALTER TABLE federation_providers ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0)");
      }
      if (!columnExists(database, "federation_transactions", "provider_generation")) {
        database.exec("ALTER TABLE federation_transactions ADD COLUMN provider_generation INTEGER NOT NULL DEFAULT 1 CHECK(provider_generation > 0)");
      }
      database.prepare(
        "INSERT OR IGNORE INTO federation_schema_migrations(version, name) VALUES (5, ?)"
      ).run("federation-provider-generation-and-saml-trust-set");
    }
    if (current < 6) {
      if (!columnExists(database, "auth_sessions", "reauthenticated_at")) {
        database.exec("ALTER TABLE auth_sessions ADD COLUMN reauthenticated_at INTEGER");
      }
      database.prepare(
        "INSERT OR IGNORE INTO federation_schema_migrations(version, name) VALUES (6, ?)"
      ).run("session-bound-admin-reauthentication");
    }
    database.pragma("user_version = " + FEDERATION_SCHEMA_VERSION);
    validateObjects(database);
    if (database.inTransaction) database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    if (error instanceof FederationMigrationError) throw error;
    throw new FederationMigrationError("federation_schema_migration_failed", "federation schema migration failed", { cause: error });
  }
}

export function hasFederationTable(database: Database.Database, table: string): boolean {
  return tableExists(database, table);
}
