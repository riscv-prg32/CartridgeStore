import { positiveInteger } from "./env-values.js";

/** Resolved backup archive and extraction limits. */
export interface BackupLimitsEnvironmentConfig {
  readonly backupMaxArchiveBytes: number;
  readonly backupMaxExpandedBytes: number;
  readonly backupMaxEntryBytes: number;
  readonly backupMaxManifestBytes: number;
  readonly backupMaxEntries: number;
  readonly backupMaxPathBytes: number;
  readonly backupMaxPathDepth: number;
  readonly backupMaxCompressionRatio: number;
}

/** Parses backup archive, path and compression limits. */
export function resolveBackupLimitsConfig(
  environment: NodeJS.ProcessEnv,
): BackupLimitsEnvironmentConfig {
  const backupMaxArchiveBytes = positiveInteger(
    "PRG32_BACKEND_BACKUP_MAX_ARCHIVE_BYTES",
    environment.PRG32_BACKEND_BACKUP_MAX_ARCHIVE_BYTES,
    1024 * 1024 * 1024,
  );
  const backupMaxExpandedBytes = positiveInteger(
    "PRG32_BACKEND_BACKUP_MAX_EXPANDED_BYTES",
    environment.PRG32_BACKEND_BACKUP_MAX_EXPANDED_BYTES,
    4 * 1024 * 1024 * 1024,
  );
  const backupMaxEntryBytes = positiveInteger(
    "PRG32_BACKEND_BACKUP_MAX_ENTRY_BYTES",
    environment.PRG32_BACKEND_BACKUP_MAX_ENTRY_BYTES,
    2 * 1024 * 1024 * 1024,
  );
  const backupMaxManifestBytes = positiveInteger(
    "PRG32_BACKEND_BACKUP_MAX_MANIFEST_BYTES",
    environment.PRG32_BACKEND_BACKUP_MAX_MANIFEST_BYTES,
    256 * 1024,
  );
  const backupMaxEntries = positiveInteger(
    "PRG32_BACKEND_BACKUP_MAX_ENTRIES",
    environment.PRG32_BACKEND_BACKUP_MAX_ENTRIES,
    50000,
  );
  const backupMaxPathBytes = positiveInteger(
    "PRG32_BACKEND_BACKUP_MAX_PATH_BYTES",
    environment.PRG32_BACKEND_BACKUP_MAX_PATH_BYTES,
    1024,
  );
  const backupMaxPathDepth = positiveInteger(
    "PRG32_BACKEND_BACKUP_MAX_PATH_DEPTH",
    environment.PRG32_BACKEND_BACKUP_MAX_PATH_DEPTH,
    32,
  );
  const backupMaxCompressionRatio =
    environment.PRG32_BACKEND_BACKUP_MAX_COMPRESSION_RATIO === undefined
      ? 200
      : Number(environment.PRG32_BACKEND_BACKUP_MAX_COMPRESSION_RATIO);
  if (
    !Number.isFinite(backupMaxCompressionRatio) ||
    backupMaxCompressionRatio <= 0
  ) {
    throw new Error(
      "PRG32_BACKEND_BACKUP_MAX_COMPRESSION_RATIO must be positive",
    );
  }

  return {
    backupMaxArchiveBytes,
    backupMaxExpandedBytes,
    backupMaxEntryBytes,
    backupMaxManifestBytes,
    backupMaxEntries,
    backupMaxPathBytes,
    backupMaxPathDepth,
    backupMaxCompressionRatio,
  };
}
