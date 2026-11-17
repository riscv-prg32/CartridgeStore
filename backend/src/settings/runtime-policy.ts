import type Database from "better-sqlite3";

type DatabaseSource = Database.Database | (() => Database.Database);

export interface RuntimePolicySnapshot {
  readonly registrationEnabled: boolean;
  readonly publishingEnabled: boolean;
  readonly maxArtifactBytes: number;
  readonly requireReviewNoteOnRejection: boolean;
  readonly sessionLifetimeSeconds: number;
  readonly telemetryCollectionEnabled: boolean;
  readonly maintenanceMode: boolean;
}

const DEFAULTS: RuntimePolicySnapshot = {
  registrationEnabled: true,
  publishingEnabled: true,
  maxArtifactBytes: 50 * 1024 * 1024,
  requireReviewNoteOnRejection: false,
  sessionLifetimeSeconds: 86400,
  telemetryCollectionEnabled: true,
  maintenanceMode: false
};

function hasTable(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function typedValue(database: Database.Database, key: string): unknown {
  if (!hasTable(database, "application_settings")) return undefined;
  const row = database.prepare("SELECT value_json FROM application_settings WHERE setting_key = ?").get(key) as { value_json?: string } | undefined;
  if (typeof row?.value_json !== "string") return undefined;
  try { return JSON.parse(row.value_json) as unknown; } catch { return undefined; }
}

function legacyValue(database: Database.Database, key: string): string | undefined {
  if (!hasTable(database, "store_settings")) return undefined;
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(key) as { value?: unknown } | undefined;
  return typeof row?.value === "string" ? row.value : undefined;
}

function booleanSetting(database: Database.Database, key: string, fallback: boolean, legacyKey?: string): boolean {
  const value = typedValue(database, key);
  if (typeof value === "boolean") return value;
  const legacy = legacyKey === undefined ? undefined : legacyValue(database, legacyKey);
  if (legacy === "true") return true;
  if (legacy === "false") return false;
  return fallback;
}

function integerSetting(database: Database.Database, key: string, fallback: number): number {
  const value = typedValue(database, key);
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export class RuntimePolicy {
  constructor(private readonly source: DatabaseSource) {}

  private get database(): Database.Database {
    return typeof this.source === "function" ? this.source() : this.source;
  }

  snapshot(): RuntimePolicySnapshot {
    const database = this.database;
    return {
      registrationEnabled: booleanSetting(database, "registration.enabled", DEFAULTS.registrationEnabled, "auth_allow_registration"),
      publishingEnabled: booleanSetting(database, "publishing.enabled", DEFAULTS.publishingEnabled),
      maxArtifactBytes: integerSetting(database, "publishing.max_artifact_bytes", DEFAULTS.maxArtifactBytes),
      requireReviewNoteOnRejection: booleanSetting(database, "review.require_note_on_rejection", DEFAULTS.requireReviewNoteOnRejection),
      sessionLifetimeSeconds: integerSetting(database, "session.lifetime_seconds", DEFAULTS.sessionLifetimeSeconds),
      telemetryCollectionEnabled: booleanSetting(database, "telemetry.collection_enabled", DEFAULTS.telemetryCollectionEnabled),
      maintenanceMode: booleanSetting(database, "maintenance.enabled", DEFAULTS.maintenanceMode)
    };
  }

  registrationEnabled(): boolean { return this.snapshot().registrationEnabled; }
  publishingEnabled(): boolean { return this.snapshot().publishingEnabled; }
  maxArtifactBytes(): number { return this.snapshot().maxArtifactBytes; }
  requireReviewNoteOnRejection(): boolean { return this.snapshot().requireReviewNoteOnRejection; }
  sessionLifetimeSeconds(): number { return this.snapshot().sessionLifetimeSeconds; }
  telemetryCollectionEnabled(): boolean { return this.snapshot().telemetryCollectionEnabled; }
  maintenanceMode(): boolean { return this.snapshot().maintenanceMode; }
}

export { DEFAULTS as RUNTIME_POLICY_DEFAULTS };
