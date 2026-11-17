import type { verifyCanonicalBackup } from "./backup.js";
import type {
  CanonicalBackupLimits,
  CanonicalBackupSnapshotMode,
  CanonicalRestoreFaultPoint,
} from "./backup.js";
import type { TARGET_VERSION_TUPLE } from "./schema.js";

/** Public ABI for encrypted backup envelopes. */
export const ENCRYPTED_BACKUP_V4_ABI =
  "prg32-cartridge-store-backup-4.0";
/** Authorization required for disposable encrypted backups. */
export const ENCRYPTED_BACKUP_V4_AUTHORIZATION =
  "PRG32_STORAGE_V2_ENCRYPTED_BACKUP_DISPOSABLE";
/** Authorization required for operational encrypted backups. */
export const ENCRYPTED_BACKUP_V4_OPERATIONAL_AUTHORIZATION =
  "PRG32_STORAGE_V2_ENCRYPTED_BACKUP_OPERATIONAL";
/** Encrypted backup envelope version. */
export const ENCRYPTED_BACKUP_V4_VERSION = 4;
/** Authorization required when applying disposable backup retention. */
export const RETENTION_AUTHORIZATION =
  "PRG32_STORAGE_V2_BACKUP_RETENTION_DISPOSABLE";

/** Lifecycle status of an encryption key. */
export type BackupKeyStatus = "active" | "decrypt-only" | "retired";

/** Key record resolved by a provider without persisting it in the archive. */
export interface BackupKeyRecord {
  readonly id: string;
  readonly status: BackupKeyStatus;
  readonly material: Buffer;
  readonly createdAt?: string;
}

/** Provider-neutral boundary for backup key material. */
export interface BackupKeyProvider {
  active(): BackupKeyRecord;
  resolve(keyId: string): BackupKeyRecord | undefined;
}

/** Authenticated header stored in an encrypted v4 envelope. */
export interface EncryptedBackupV4Header {
  readonly abi: typeof ENCRYPTED_BACKUP_V4_ABI;
  readonly format_version: typeof ENCRYPTED_BACKUP_V4_VERSION;
  readonly application: "prg32-cartridge-store";
  readonly backup_id: string;
  readonly created_at: string;
  readonly payload_abi: "prg32-cartridge-store-backup-3.0";
  readonly payload_format_version: 3;
  readonly versions: typeof TARGET_VERSION_TUPLE;
  readonly payload_archive_bytes: number;
  readonly payload_archive_sha256: string;
  readonly payload_manifest_sha256: string;
  readonly key_id: string;
  readonly cipher: "aes-256-gcm";
  readonly key_wrap: "aes-256-gcm";
  readonly nonce: string;
  readonly wrapped_key: string;
  readonly wrap_nonce: string;
  readonly wrap_tag: string;
  readonly tag_bytes: 16;
}

/** Resource limits applied to the encrypted envelope and v3 payload. */
export interface EncryptedBackupV4Limits {
  readonly maxEnvelopeBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxPayloadBytes: number;
  readonly canonical?: Partial<CanonicalBackupLimits>;
}

/** Default limits for encrypted backup operations. */
export const DEFAULT_ENCRYPTED_BACKUP_V4_LIMITS: EncryptedBackupV4Limits = {
  maxEnvelopeBytes: 4 * 1024 * 1024 * 1024 + 128 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxPayloadBytes: 4 * 1024 * 1024 * 1024,
};

/** Fault injection points during encrypted backup processing. */
export type EncryptedBackupV4FaultPoint =
  | "after-payload-created"
  | "during-encryption"
  | "before-envelope-finalization"
  | "after-envelope-finalization"
  | "before-decryption"
  | "during-decryption"
  | "after-decryption";

/** Input for creating an encrypted canonical backup. */
export interface CreateEncryptedBackupOptions {
  readonly sourceRoot: string;
  readonly outputPath: string;
  readonly authorization: string;
  readonly keyProvider: BackupKeyProvider;
  readonly writerQuiesced: boolean;
  readonly snapshotMode?: CanonicalBackupSnapshotMode;
  readonly limits?: Partial<EncryptedBackupV4Limits>;
  readonly fault?: (point: EncryptedBackupV4FaultPoint) => void;
}

/** Input for verifying an encrypted backup. */
export interface VerifyEncryptedBackupOptions {
  readonly keyProvider: BackupKeyProvider;
  readonly limits?: Partial<EncryptedBackupV4Limits>;
  readonly fault?: (point: EncryptedBackupV4FaultPoint) => void;
}

/** Input for restoring an encrypted backup. */
export interface RestoreEncryptedBackupOptions
  extends VerifyEncryptedBackupOptions {
  readonly archivePath: string;
  readonly targetRoot: string;
  readonly authorization: string;
  readonly restoreFault?: (point: CanonicalRestoreFaultPoint) => void;
}

/** Result returned after creating or inspecting an encrypted envelope. */
export interface EncryptedBackupV4Result {
  readonly backupId: string;
  readonly archivePath: string;
  readonly completionMarker: string;
  readonly header: EncryptedBackupV4Header;
  readonly envelopeBytes: number;
}

/** Result returned after verifying the encrypted payload. */
export interface VerifiedEncryptedBackupV4 extends EncryptedBackupV4Result {
  readonly payloadManifest: ReturnType<typeof verifyCanonicalBackup>["manifest"];
  readonly payloadArchiveSha256: string;
}

/** Input for dry-run or applied encrypted backup retention. */
export interface RetentionOptions {
  readonly directory: string;
  readonly keepNewest: number;
  readonly maxAgeMs?: number;
  readonly protectedBackupIds?: readonly string[];
  readonly apply?: boolean;
  readonly authorization?: string;
}

/** Retention candidates and files protected by policy. */
export interface RetentionResult {
  readonly dryRun: boolean;
  readonly candidates: readonly string[];
  readonly protectedFiles: readonly string[];
  readonly deleted: readonly string[];
}

/** Input for creating a new key registry without overwriting the source. */
export interface BackupKeyRotationOptions {
  readonly inputRegistryPath: string;
  readonly outputRegistryPath: string;
  readonly newKeyId: string;
}
