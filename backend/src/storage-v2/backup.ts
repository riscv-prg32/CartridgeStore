import fs from "node:fs";

import { BackupError } from "../backup/format.js";
import type {
  CanonicalBackupLimits,
  CanonicalBackupManifest,
} from "./backup-contracts.js";
import {
  createCanonicalBackup,
} from "./backup-creation.js";
import {
  restoreCanonicalBackup,
  restoreStateFile,
} from "./backup-restore.js";
import { verifyCanonicalBackup as verifyBackupArchive } from "./backup-verification.js";

export {
  CANONICAL_BACKUP_ABI,
  CANONICAL_BACKUP_AUTHORIZATION,
  CANONICAL_BACKUP_OPERATIONAL_AUTHORIZATION,
  CANONICAL_BACKUP_VERSION,
  DEFAULT_CANONICAL_BACKUP_LIMITS,
} from "./backup-contracts.js";
export type {
  CanonicalBackupFaultPoint,
  CanonicalBackupInventoryEntry,
  CanonicalBackupLimits,
  CanonicalBackupManifest,
  CanonicalBackupOptions,
  CanonicalBackupResult,
  CanonicalBackupSnapshotMode,
  CanonicalRestoreFaultPoint,
  CanonicalRestoreOptions,
  CanonicalRestoreReport,
  CanonicalRestoreResult,
} from "./backup-contracts.js";
export { createCanonicalBackup, restoreCanonicalBackup };

/** Verifies a canonical backup archive through the existing public facade. */
export function verifyCanonicalBackup(
  archivePathValue: string,
  options: { readonly limits?: Partial<CanonicalBackupLimits> } = {},
): {
  readonly manifest: CanonicalBackupManifest;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
} {
  return verifyBackupArchive(archivePathValue, options);
}

/** Rejects a restore target with an existing durable restore journal. */
export function assertRestoreTargetNotReady(root: string): void {
  const statePath = restoreStateFile(root);
  if (fs.existsSync(statePath)) {
    throw new BackupError(
      "canonical restore target has an incomplete or completed restore journal",
      "canonical_restore_target_not_ready",
      409,
    );
  }
}
