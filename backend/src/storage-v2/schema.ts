import {
  TARGET_APPLICATION,
  TARGET_BACKUP_FORMAT_VERSION,
  TARGET_PUBLICATION_JOURNAL_VERSION,
  TARGET_SCHEMA_VERSION,
  TARGET_STORAGE_LAYOUT_VERSION
} from "./types.js";

/**
 * These are the compatible tables required by the target database. The
 * existing Fastify Drizzle schema is a mapping, not a DDL initializer, so the
 * target foundation owns this explicit disposable bootstrap SQL. The columns
 * intentionally match backend/src/db/schema.ts and the Python schema snapshot.
 */
export const COMPATIBLE_SCHEMA_SQL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  external_id TEXT,
  external_provider TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT,
  disabled_at TEXT
);
CREATE INDEX users_external_idx ON users(external_provider, external_id);

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used TEXT
);
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id);

CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_groups (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE registration_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX registration_tokens_email_idx ON registration_tokens(email, used_at, expires_at);

CREATE TABLE store_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  player TEXT NOT NULL,
  score INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  submitted_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX scores_game_score_idx ON scores(game, score DESC, created_at ASC);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  target TEXT NOT NULL,
  display_backend TEXT NOT NULL DEFAULT '',
  firmware_version TEXT NOT NULL DEFAULT '',
  firmware_git_sha TEXT NOT NULL DEFAULT '',
  game_name TEXT NOT NULL DEFAULT '',
  sample_period_frames INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  dropped_samples INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  submitted_by TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id)
);

CREATE TABLE samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  frame INTEGER NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  update_us INTEGER NOT NULL,
  draw_us INTEGER NOT NULL,
  present_us INTEGER NOT NULL,
  frame_us INTEGER NOT NULL,
  heap_free INTEGER NOT NULL,
  heap_min_free INTEGER NOT NULL,
  input_mask INTEGER NOT NULL,
  fps_x100 INTEGER NOT NULL,
  upload_queue_depth INTEGER NOT NULL,
  deadline_missed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE (run_id, frame)
);
CREATE INDEX samples_run_frame_idx ON samples(run_id, frame);
CREATE INDEX samples_run_frame_time_idx ON samples(run_id, frame_us);
`;

export const TARGET_SCHEMA_SQL = `
CREATE TABLE storage_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  application TEXT NOT NULL CHECK (application = '${TARGET_APPLICATION}'),
  schema_version INTEGER NOT NULL,
  storage_layout_version INTEGER NOT NULL,
  publication_journal_version INTEGER NOT NULL,
  backup_format_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'migration_running', 'recovery_required')),
  source_schema_fingerprint TEXT,
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE schema_migrations (
  migration_id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'applied', 'failed', 'rolled_back')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  checksum TEXT NOT NULL,
  error_code TEXT,
  UNIQUE (component, version)
);

CREATE TABLE cartridges (
  cartridge_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  publisher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'withdrawn'))
);

CREATE TABLE releases (
  release_id TEXT PRIMARY KEY,
  cartridge_id TEXT NOT NULL REFERENCES cartridges(cartridge_id) ON DELETE RESTRICT,
  version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('draft', 'pending_review', 'published', 'superseded', 'withdrawn', 'rejected')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  authors_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL,
  colophon_json TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  published_at TEXT,
  superseded_at TEXT,
  published_order INTEGER,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  supersedes_release_id TEXT REFERENCES releases(release_id) ON DELETE RESTRICT,
  UNIQUE (cartridge_id, version, revision),
  CHECK ((state = 'published') = (published_at IS NOT NULL AND published_order IS NOT NULL)),
  CHECK (state <> 'superseded' OR superseded_at IS NOT NULL)
);
CREATE INDEX releases_catalog_idx ON releases(cartridge_id, state, published_order DESC);
CREATE INDEX releases_version_idx ON releases(cartridge_id, version, state, revision DESC);
CREATE UNIQUE INDEX releases_one_published_revision_idx ON releases(cartridge_id, version) WHERE state = 'published';
CREATE UNIQUE INDEX releases_published_order_idx ON releases(published_order) WHERE published_order IS NOT NULL;

CREATE TABLE storage_objects (
  object_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('artifact', 'media', 'site_asset')),
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  media_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'available', 'quarantined', 'retired')),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  created_by_operation_id TEXT
);
CREATE INDEX storage_objects_hash_idx ON storage_objects(sha256, size_bytes, object_kind);
CREATE INDEX storage_objects_state_idx ON storage_objects(state, created_at);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(release_id) ON DELETE RESTRICT,
  architecture TEXT NOT NULL CHECK (architecture IN ('esp32c6', 'qemu')),
  object_id TEXT NOT NULL REFERENCES storage_objects(object_id) ON DELETE RESTRICT,
  compatibility_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('staged', 'published', 'superseded', 'withdrawn')),
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE (release_id, architecture),
  CHECK (state <> 'superseded' OR superseded_at IS NOT NULL)
);
CREATE INDEX artifacts_release_state_idx ON artifacts(release_id, state, architecture);
CREATE INDEX artifacts_object_idx ON artifacts(object_id);

CREATE TABLE media (
  media_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(release_id) ON DELETE RESTRICT,
  architecture TEXT NOT NULL DEFAULT '' CHECK (architecture IN ('', 'esp32c6', 'qemu')),
  kind TEXT NOT NULL CHECK (kind IN ('icon', 'screenshot')),
  object_id TEXT NOT NULL REFERENCES storage_objects(object_id) ON DELETE RESTRICT,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (release_id, architecture, kind)
);
CREATE INDEX media_lookup_idx ON media(release_id, kind, architecture);
CREATE INDEX media_object_idx ON media(object_id);

CREATE TABLE site_assets (
  asset_id TEXT PRIMARY KEY,
  asset_key TEXT NOT NULL UNIQUE,
  object_id TEXT NOT NULL REFERENCES storage_objects(object_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX site_assets_state_idx ON site_assets(state, asset_key);

CREATE TABLE submissions (
  submission_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cartridge_id TEXT NOT NULL REFERENCES cartridges(cartridge_id) ON DELETE RESTRICT,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('validated', 'pending_review', 'approved', 'published', 'rejected', 'cancelled', 'recovery_required')),
  submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_by TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  published_release_id TEXT REFERENCES releases(release_id) ON DELETE SET NULL,
  legacy_submission_id INTEGER UNIQUE
);
CREATE INDEX submissions_status_idx ON submissions(status, created_at DESC, submission_id DESC);
CREATE INDEX submissions_owner_idx ON submissions(submitted_by_user_id, created_at DESC);

CREATE TABLE submission_artifacts (
  submission_artifact_id TEXT PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(submission_id) ON DELETE CASCADE,
  architecture TEXT NOT NULL CHECK (architecture IN ('esp32c6', 'qemu')),
  source_filename TEXT NOT NULL,
  staging_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  media_type TEXT NOT NULL DEFAULT 'application/vnd.prg32.cartridge',
  validation_state TEXT NOT NULL CHECK (validation_state IN ('staged', 'validated', 'invalid', 'promoted', 'quarantined')),
  metadata_json TEXT NOT NULL,
  colophon_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (submission_id, architecture)
);
CREATE INDEX submission_artifacts_submission_idx ON submission_artifacts(submission_id, architecture);

CREATE TABLE review_decisions (
  decision_id TEXT PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(submission_id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'cancelled')),
  reviewer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_name TEXT NOT NULL DEFAULT '',
  metadata_json TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX review_decisions_submission_idx ON review_decisions(submission_id, created_at DESC);

CREATE TABLE publication_operations (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('submission', 'catalog', 'migration')),
  submission_id INTEGER REFERENCES submissions(submission_id) ON DELETE RESTRICT,
  release_id TEXT REFERENCES releases(release_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'objects_staged', 'objects_verified', 'database_committed', 'cleanup_pending', 'completed', 'recovery_required', 'compensating', 'compensated', 'failed')),
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX publication_operations_state_idx ON publication_operations(state, updated_at);

CREATE TABLE publication_operation_items (
  operation_item_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES publication_operations(operation_id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('artifact', 'media', 'site_asset')),
  architecture TEXT NOT NULL DEFAULT '',
  target_role TEXT NOT NULL,
  expected_object_id TEXT NOT NULL REFERENCES storage_objects(object_id) ON DELETE RESTRICT,
  source_staging_key TEXT,
  target_storage_key TEXT NOT NULL,
  expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('planned', 'staged', 'verified', 'committed', 'quarantined')),
  UNIQUE (operation_id, expected_object_id),
  CHECK (
    (item_kind = 'artifact' AND architecture IN ('esp32c6', 'qemu') AND target_role = 'artifact') OR
    (item_kind = 'media' AND architecture IN ('', 'esp32c6', 'qemu') AND target_role IN ('icon', 'screenshot')) OR
    (item_kind = 'site_asset' AND architecture = '' AND target_role = 'site_asset')
  )
);
CREATE INDEX publication_operation_items_operation_idx ON publication_operation_items(operation_id, state);

CREATE TABLE publication_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES publication_operations(operation_id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  event_code TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX publication_events_operation_idx ON publication_events(operation_id, event_id);

CREATE TABLE download_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cartridge_id TEXT NOT NULL REFERENCES cartridges(cartridge_id) ON DELETE RESTRICT,
  release_id TEXT NOT NULL REFERENCES releases(release_id) ON DELETE RESTRICT,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  version TEXT NOT NULL,
  architecture TEXT NOT NULL CHECK (architecture IN ('esp32c6', 'qemu')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_hash TEXT,
  user_agent TEXT,
  downloaded_at TEXT NOT NULL,
  delivery_outcome TEXT NOT NULL DEFAULT 'started' CHECK (delivery_outcome IN ('started', 'completed', 'failed', 'unknown'))
);
CREATE INDEX download_events_artifact_idx ON download_events(artifact_id, downloaded_at);
CREATE INDEX download_events_game_idx ON download_events(cartridge_id, downloaded_at);
CREATE INDEX download_events_arch_idx ON download_events(architecture, downloaded_at);

CREATE TABLE migration_exceptions (
  exception_id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('download_event', 'site_asset', 'submission', 'release', 'artifact', 'other')),
  legacy_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (migration_id, entity_kind, legacy_id)
);
CREATE INDEX migration_exceptions_migration_idx ON migration_exceptions(migration_id, entity_kind);
`;

export const TARGET_TABLES = [
  "storage_metadata",
  "schema_migrations",
  "cartridges",
  "releases",
  "storage_objects",
  "artifacts",
  "media",
  "site_assets",
  "submissions",
  "submission_artifacts",
  "review_decisions",
  "publication_operations",
  "publication_operation_items",
  "publication_events",
  "download_events",
  "migration_exceptions"
] as const;

export const COMPATIBLE_TABLES = [
  "users",
  "groups",
  "user_groups",
  "api_tokens",
  "registration_tokens",
  "store_settings",
  "scores",
  "runs",
  "samples"
] as const;

export const TARGET_VERSION_TUPLE = {
  schemaVersion: TARGET_SCHEMA_VERSION,
  storageLayoutVersion: TARGET_STORAGE_LAYOUT_VERSION,
  publicationJournalVersion: TARGET_PUBLICATION_JOURNAL_VERSION,
  backupFormatVersion: TARGET_BACKUP_FORMAT_VERSION
} as const;
