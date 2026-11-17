import type { auditStorage } from "./integrity.js";
import type { TARGET_VERSION_TUPLE } from "./schema.js";
import type { ObjectKind } from "./types.js";

/** Public ABI for the canonical storage backup format. */
export const CANONICAL_BACKUP_ABI = "prg32-cartridge-store-backup-3.0";
/** Authorization required for disposable canonical backups. */
export const CANONICAL_BACKUP_AUTHORIZATION =
  "PRG32_STORAGE_V2_DISPOSABLE_BACKUP";
/** Authorization required for operational canonical backups. */
export const CANONICAL_BACKUP_OPERATIONAL_AUTHORIZATION =
  "PRG32_STORAGE_V2_OPERATIONAL_BACKUP";
/** Canonical backup format version. */
export const CANONICAL_BACKUP_VERSION = 3;

/** Resource limits applied while creating or restoring a backup. */
export interface CanonicalBackupLimits {
  readonly maxArchiveBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxEntryBytes: number;
  readonly maxManifestBytes: number;
  readonly maxEntries: number;
  readonly maxPathBytes: number;
  readonly maxPathDepth: number;
  readonly maxCompressionRatio: number;
}

/** Default limits for canonical backup operations. */
export const DEFAULT_CANONICAL_BACKUP_LIMITS: CanonicalBackupLimits = {
  maxArchiveBytes: 4 * 1024 * 1024 * 1024,
  maxExpandedBytes: 8 * 1024 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxEntries: 50_000,
  maxPathBytes: 1024,
  maxPathDepth: 32,
  maxCompressionRatio: 200,
};

/** Fault injection points during canonical backup creation. */
export type CanonicalBackupFaultPoint =
  | "before-sqlite-snapshot"
  | "after-sqlite-snapshot"
  | "during-object-inventory"
  | "during-object-streaming"
  | "before-archive-finalization"
  | "after-archive-finalization";

/** SQLite snapshot mode for a canonical backup. */
export type CanonicalBackupSnapshotMode = "exclusive" | "online";

/** Fault injection points during canonical restore. */
export type CanonicalRestoreFaultPoint =
  | "before-target-initialization"
  | "after-sqlite-restore"
  | "during-object-extraction"
  | "during-staging-restoration"
  | "during-journal-restoration"
  | "before-final-integrity-verification"
  | "after-verification-before-completion";

/** Input for creating a canonical backup archive. */
export interface CanonicalBackupOptions {
  readonly sourceRoot: string;
  readonly outputPath: string;
  readonly authorization: string;
  readonly writerQuiesced: boolean;
  /** Exclusive is historical; online does not own the writer lease. */
  readonly snapshotMode?: CanonicalBackupSnapshotMode;
  readonly limits?: Partial<CanonicalBackupLimits>;
  readonly fault?: (point: CanonicalBackupFaultPoint) => void;
}

/** Input for restoring a canonical backup archive. */
export interface CanonicalRestoreOptions {
  readonly archivePath: string;
  readonly targetRoot: string;
  readonly authorization: string;
  readonly limits?: Partial<CanonicalBackupLimits>;
  readonly fault?: (point: CanonicalRestoreFaultPoint) => void;
}

/** Result returned after creating a canonical backup archive. */
export interface CanonicalBackupResult {
  readonly backupId: string;
  readonly archivePath: string;
  readonly completionMarker: string;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly manifest: CanonicalBackupManifest;
}

/** Result returned after restoring a canonical backup archive. */
export interface CanonicalRestoreResult {
  readonly backupId: string;
  readonly targetRoot: string;
  readonly state: "completed" | "recovery_required";
  readonly operationId: string;
  readonly report: CanonicalRestoreReport;
}

/** One file represented in a canonical backup manifest. */
export interface CanonicalBackupInventoryEntry {
  readonly archivePath: string;
  readonly sourceKey: string;
  readonly kind:
    | "sqlite_snapshot"
    | "object"
    | "submission_staging"
    | "journal"
    | "quarantine"
    | "compatibility";
  readonly objectKind?: ObjectKind;
  readonly objectId?: string;
  readonly storageKey?: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly classification:
    | "required"
    | "optional"
    | "reconstructible"
    | "recovery_required";
}

/** Canonical manifest persisted inside a backup archive. */
export interface CanonicalBackupManifest {
  readonly abi: typeof CANONICAL_BACKUP_ABI;
  readonly format_version: typeof CANONICAL_BACKUP_VERSION;
  readonly application: "prg32-cartridge-store";
  readonly backup_id: string;
  readonly created_at: string;
  readonly snapshot: {
    readonly identity: string;
    readonly database: "database.sqlite";
    readonly size_bytes: number;
    readonly sha256: string;
  };
  readonly versions: typeof TARGET_VERSION_TUPLE;
  readonly schema: {
    readonly fingerprint: string;
    readonly tables: readonly string[];
  };
  readonly inventory: readonly CanonicalBackupInventoryEntry[];
  readonly object_count: number;
  readonly object_kinds: Readonly<Record<ObjectKind, number>>;
  readonly staging_count: number;
  readonly recovery_required: boolean;
  readonly required_recovery_material: readonly string[];
  readonly aggregate_bytes: { readonly expanded: number; readonly archive: number };
  readonly archive_inventory_sha256: string;
  readonly canonical_manifest_sha256: string;
  readonly verification_state: "complete" | "recovery_required";
}

/** Integrity and inventory report returned by restore. */
export interface CanonicalRestoreReport {
  readonly databaseSha256: string;
  readonly inventoryEntries: number;
  readonly objectsVerified: number;
  readonly stagingEntries: number;
  readonly recoveryMaterialEntries: number;
  readonly integrity: ReturnType<typeof auditStorage>;
  readonly databaseFingerprint: string;
}
