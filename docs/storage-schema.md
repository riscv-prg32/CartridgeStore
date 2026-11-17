# PRG32 Cartridge Store — canonical storage schema

Date: 2026-10-14
Status: canonical compatibility specification.

This specification complements the repository architecture and migration
documentation. The SQL is an executable compatibility contract for the
canonical storage-v2 schema, but it is not a migration script: do not run
these statements directly against an existing operational database.

## 1. Conventions

- SQLite foreign keys are enabled on every connection.
- Timestamps are UTC RFC3339 strings with `Z` for catalog/publication rows.
  Existing firmware metrics and scores retain their current integer timestamp
  units and compatibility semantics.
- IDs are opaque lowercase server-generated UUIDv7/ULID-compatible text unless
  explicitly stated. They are not user input and are not replacements for
  public `cartridge_id`, `version`, or `architecture`.
- Hashes are lowercase hexadecimal SHA-256 strings of the exact stored bytes;
  physical hash, size, MIME type, and generated storage key live only on
  `storage_objects` once bytes are promoted.
- Empty string architecture means release-wide media. Artifact architecture is
  always one of `esp32c6` or `qemu`.
- JSON columns retain ABI payloads losslessly after schema validation. They are
  canonical database values, not filesystem metadata.
- All `CHECK` expressions below are target rules. The implementation may use
  application validation as well, but it must fail closed if validation is
  bypassed.

## 2. Schema/version metadata

```sql
CREATE TABLE storage_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  application TEXT NOT NULL CHECK (application = 'prg32-cartridge-store'),
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
```

The current target tuple is schema `2`, storage layout `2`, publication
journal `1`, and backup format `3`. The service refuses write startup if the
singleton is missing, incompatible, or not `ready`.

## 3. Cartridges and releases

```sql
CREATE TABLE cartridges (
  cartridge_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  publisher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'withdrawn'))
);

CREATE TABLE releases (
  release_id TEXT PRIMARY KEY,
  cartridge_id TEXT NOT NULL REFERENCES cartridges(cartridge_id) ON DELETE RESTRICT,
  version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL
    CHECK (state IN ('draft', 'pending_review', 'published', 'superseded', 'withdrawn', 'rejected')),
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

CREATE INDEX releases_catalog_idx
  ON releases (cartridge_id, state, published_order DESC);
CREATE INDEX releases_version_idx
  ON releases (cartridge_id, version, state, revision DESC);
CREATE UNIQUE INDEX releases_one_published_revision_idx
  ON releases (cartridge_id, version)
  WHERE state = 'published';
CREATE UNIQUE INDEX releases_published_order_idx
  ON releases (published_order)
  WHERE published_order IS NOT NULL;
```

`published_order` is assigned monotonically inside the publication transaction.
It preserves the current behavior that the latest successful publication is the
selected latest version; it does not compare version strings as semantic
versions. A same-version replacement creates a new `revision` and
`release_id`, marks the former release `superseded`, and keeps the former
artifact for rollback/retention.

The partial unique index assumes one public revision per `(cartridge_id,
version)`. If later policy requires multiple simultaneously public revisions,
that rule must be changed explicitly with an API selection contract; it must
not be inferred from file names.

## 4. Storage objects and artifacts

```sql
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

CREATE INDEX storage_objects_hash_idx
  ON storage_objects (sha256, size_bytes, object_kind);
CREATE INDEX storage_objects_state_idx
  ON storage_objects (state, created_at);

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

CREATE INDEX artifacts_release_state_idx
  ON artifacts (release_id, state, architecture);
CREATE INDEX artifacts_object_idx
  ON artifacts (object_id);
```

`storage_objects` is the sole authority for physical object metadata. The
artifact relationship stores only release, architecture, lifecycle and
compatibility information. A published artifact is resolvable only when its
referenced object is `available`; the object resolver supplies the canonical
hash, byte size and media type for downloads and audits. No physical metadata
is duplicated in `artifacts`.

## 5. Media

```sql
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

CREATE INDEX media_lookup_idx
  ON media (release_id, kind, architecture);
CREATE INDEX media_object_idx
  ON media (object_id);
```

The resolver first tries the selected architecture and then the release-wide
empty architecture. A release may have one or both. Colophon is not a `media`
row; it is structured release JSON because its API contract is JSON and its
size is bounded.

## 6. Application/site assets

Branding and administrator-managed custom assets have a relationship of their
own. They are not cartridge media and do not participate in catalog release
visibility.

```sql
CREATE TABLE site_assets (
  asset_id TEXT PRIMARY KEY,
  asset_key TEXT NOT NULL UNIQUE,
  object_id TEXT NOT NULL REFERENCES storage_objects(object_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX site_assets_state_idx
  ON site_assets (state, asset_key);
```

`asset_key` is a bounded logical key such as `branding.logo`,
`branding.favicon`, or an approved custom key. It is never concatenated into a
filesystem path. The public legacy `/static/custom/<filename>` route may be a
compatibility projection while the canonical API resolves a logical
key to an object and applies the same MIME/size/path checks as cartridge media.
`storage_objects` remains the sole authority for the asset's physical metadata;
`site_assets` contains only the logical relationship and lifecycle state.

## 7. Submissions and review

```sql
CREATE TABLE submissions (
  submission_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cartridge_id TEXT NOT NULL REFERENCES cartridges(cartridge_id) ON DELETE RESTRICT,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('validated', 'pending_review', 'approved', 'published', 'rejected', 'cancelled', 'recovery_required')),
  submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_by TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  published_release_id TEXT REFERENCES releases(release_id) ON DELETE SET NULL,
  legacy_submission_id INTEGER UNIQUE
);

CREATE INDEX submissions_status_idx
  ON submissions (status, created_at DESC, submission_id DESC);
CREATE INDEX submissions_owner_idx
  ON submissions (submitted_by_user_id, created_at DESC);

CREATE TABLE submission_artifacts (
  submission_artifact_id TEXT PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(submission_id) ON DELETE CASCADE,
  architecture TEXT NOT NULL CHECK (architecture IN ('esp32c6', 'qemu')),
  source_filename TEXT NOT NULL,
  staging_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  media_type TEXT NOT NULL DEFAULT 'application/vnd.prg32.cartridge',
  validation_state TEXT NOT NULL
    CHECK (validation_state IN ('staged', 'validated', 'invalid', 'promoted', 'quarantined')),
  metadata_json TEXT NOT NULL,
  colophon_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (submission_id, architecture)
);

CREATE INDEX submission_artifacts_submission_idx
  ON submission_artifacts (submission_id, architecture);

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

CREATE INDEX review_decisions_submission_idx
  ON review_decisions (submission_id, created_at DESC);
```

`submission_id` remains an integer because existing public routes expose it.
The migration sets `legacy_submission_id` to the old ID and continues from the
maximum imported value. `staging_key` is a generated relative key, never a
user-provided path.

## 8. Publication journal

```sql
CREATE TABLE publication_operations (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('submission', 'catalog', 'migration')),
  submission_id INTEGER REFERENCES submissions(submission_id) ON DELETE RESTRICT,
  release_id TEXT REFERENCES releases(release_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'objects_staged', 'objects_verified', 'database_committed',
    'cleanup_pending', 'completed', 'recovery_required', 'compensating',
    'compensated', 'failed'
  )),
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX publication_operations_state_idx
  ON publication_operations (state, updated_at);

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

CREATE INDEX publication_operation_items_operation_idx
  ON publication_operation_items (operation_id, state);

CREATE TABLE publication_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES publication_operations(operation_id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  event_code TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX publication_events_operation_idx
  ON publication_events (operation_id, event_id);
```

The operation manifest contains all expected object IDs, hashes, sizes,
release ID/revision, and the source submission. It is bounded and contains no
secrets. `expected_sha256` and `expected_size_bytes` are journal assertions,
not a second authority for an already-promoted object's metadata; they must
match the referenced `storage_objects` row before commit. The unique key is
the expected object identity, so one operation can contain multiple media
items for the same release, including icon and screenshot variants for both
`esp32c6` and `qemu`. The database row is the authoritative journal; an
optional matching `journal/publications/<operation_id>/plan.json` is an audit
copy.

## 9. Downloads

```sql
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
  delivery_outcome TEXT NOT NULL DEFAULT 'started'
    CHECK (delivery_outcome IN ('started', 'completed', 'failed', 'unknown'))
);

CREATE INDEX download_events_artifact_idx
  ON download_events (artifact_id, downloaded_at);
CREATE INDEX download_events_game_idx
  ON download_events (cartridge_id, downloaded_at);
CREATE INDEX download_events_arch_idx
  ON download_events (architecture, downloaded_at);

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

CREATE INDEX migration_exceptions_migration_idx
  ON migration_exceptions (migration_id, entity_kind);
```

The `version` and `architecture` columns remain a compatibility projection and
are checked against the referenced rows on insert. Historical rows that
cannot be mapped to an artifact are preserved in a migration exception table
or a legacy archive, not silently attached to a guessed artifact.

## 10. Existing compatible tables

These tables remain part of the target database with their current public
columns and identifiers unless a later milestone authorizes a separate auth or
telemetry migration:

- `users`, `groups`, `user_groups`, `api_tokens`, and
  `registration_tokens` preserve account, role, group, token, and registration
  compatibility;
- `store_settings` preserves settings and discovery configuration;
- `scores` preserves anonymous firmware score submission shape and ordering;
- `runs` and `samples` preserve firmware metrics payloads and export shape.

The old `cartridge_submissions` table is an input structure, not a target
authority. Its rows map to `submissions`, and its JSON architecture list maps
to `submission_artifacts`. The old `index.json` is an input/export only.

Scores and runs currently contain free-text `game`/`game_name` fields. M5.2
does not silently reinterpret them or add a foreign key that could reject
existing firmware data. A future optional nullable `cartridge_id` association
must be a separately gated compatibility enhancement.

## 11. Lifecycle rules

### Release

```text
draft -> pending_review -> published -> superseded
draft -> rejected
published -> withdrawn
pending_review -> rejected | recovery_required
```

Only `published` releases with available artifacts are public. `withdrawn` and
`superseded` rows remain for audit/rollback but are excluded from default
catalog queries. No update modifies a published artifact's bytes.

### Artifact and object

```text
storage_object staged -> available -> retired
storage_object staged -> quarantined
artifact staged -> published -> superseded | withdrawn
```

`retired` is allowed only after the artifact is unreachable, no recoverable
operation references it, retention has elapsed, and an explicit GC plan is
approved. `quarantined` objects are never served.

### Submission and operation

Submission transitions are controlled by the review service and operation
transitions are controlled by the publication coordinator. A route must reject
illegal transitions with a stable error code. Repeated approval/recovery of a
completed operation is idempotent.

## 12. Legacy mapping summary

| Legacy source | Target | Mapping rule |
| --- | --- | --- |
| `index.games[game_id]` | `cartridges` + `releases` | preserve `game_id`; create release per version/revision |
| `versions[version]` | `releases` | preserve public version; title/summary/tags/authors/metadata/colophon |
| `architectures[arch]` | `artifacts` | preserve `esp32c6`/`qemu`, hash actual bytes |
| `variants[].filename` | `storage_objects.storage_key` | validate only as source path; generate new target object key |
| embedded ICON/SCREEN | `media` | parse bytes, hash, store immutable object |
| `cartridge_submissions` | `submissions` | preserve integer ID in both submission fields |
| `architectures_json` | `submission_artifacts` | one row per validated architecture |
| `download_events` | target `download_events` | map by game/version/architecture; preserve unmappable rows as exceptions |
| custom/logo/favicon asset files and settings | `site_assets` + `storage_objects` | import as logical asset keys and generated immutable objects |
| users/groups/tokens/settings | same-compatible tables | copy with FK and uniqueness validation |
| scores/runs/samples | same-compatible tables | copy unchanged and validate counts/FKs |

## 13. Query invariants

The implementation must enforce these invariants in tests and integrity audit:

1. Every public artifact has exactly one published release, architecture,
   object, size, and SHA-256 match.
2. No published release has an unavailable object or invalid required media.
3. At most one published revision exists for a public cartridge/version.
4. Every submission artifact has a safe private staging key until promoted.
5. Every publication operation has a monotonic event sequence and valid state.
6. Every download event resolves to a real published artifact or is explicitly
   marked as a preserved legacy exception outside public aggregates.
7. No catalog query enumerates the object filesystem or reads `index.json`.
