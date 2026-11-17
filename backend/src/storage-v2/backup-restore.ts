import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { extractZipArchive } from "../backup/archive.js";
import { BackupError } from "../backup/format.js";
import { auditStorage } from "./integrity.js";
import { initializeDisposableStorage, isDisposablePath } from "./database.js";
import type {
  CanonicalRestoreOptions,
  CanonicalRestoreReport,
  CanonicalRestoreResult,
} from "./backup-contracts.js";
import {
  copyExtractedData,
  promoteRestoredDatabase,
  restoreStatePath,
  writeRestoreState as writeState,
} from "./backup-restore-io.js";
import {
  canonicalBackupConfig,
  canonicalBackupLimits,
  resolvedBackupPath,
} from "./backup-manifest.js";
import { verifyCanonicalBackup } from "./backup-verification.js";
import { schemaFingerprint, sha256File } from "./backup-validation.js";
import type { StorageDatabase } from "./types.js";
import {
  CANONICAL_BACKUP_ABI,
  CANONICAL_BACKUP_AUTHORIZATION,
} from "./backup-contracts.js";

/** Restores and verifies a canonical backup into a disposable root. */
export function restoreCanonicalBackup(
  options: CanonicalRestoreOptions,
): CanonicalRestoreResult {
  if (options.authorization !== CANONICAL_BACKUP_AUTHORIZATION) {
    throw new BackupError(
      "explicit disposable restore authorization is required",
      "canonical_backup_authorization_required",
      403,
    );
  }
  const archivePath = resolvedBackupPath(options.archivePath, "archive path");
  const targetRoot = resolvedBackupPath(options.targetRoot, "target root");
  if (!isDisposablePath(targetRoot)) {
    throw new BackupError(
      "canonical restore target must be disposable",
      "canonical_restore_target_not_disposable",
      403,
    );
  }
  if (fs.existsSync(targetRoot) && fs.readdirSync(targetRoot).length > 0) {
    throw new BackupError(
      "canonical restore target must be a new empty root",
      "canonical_restore_conflict",
      409,
    );
  }
  const limitValue = canonicalBackupLimits(options.limits);
  const verified = verifyCanonicalBackup(archivePath, {
    limits: limitValue,
  });
  const operationId = crypto.randomUUID();
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "prg32-storage-v2-restore-"),
  );
  let resource: StorageDatabase | undefined;
  try {
    options.fault?.("before-target-initialization");
    const initialized = initializeDisposableStorage(targetRoot);
    resource = initialized;
    const targetPaths = initialized.paths;
    writeState(targetRoot, {
      abi: CANONICAL_BACKUP_ABI,
      operation_id: operationId,
      backup_id: verified.manifest.backup_id,
      archive_sha256: verified.archiveSha256,
      state: "preparing",
      updated_at: new Date().toISOString(),
    });
    resource.close();
    resource = undefined;
    const extracted = extractZipArchive(
      archivePath,
      temporary,
      canonicalBackupConfig(limitValue),
    );
    fs.rmSync(path.join(targetRoot, "store.sqlite"), { force: true });
    promoteRestoredDatabase(
      extracted.databasePath,
      path.join(targetRoot, "store.sqlite"),
    );
    const originalDatabaseIdentity = sha256File(targetPaths.databasePath);
    if (originalDatabaseIdentity.sha256 !== verified.manifest.snapshot.sha256) {
      throw new BackupError(
        "restored SQLite snapshot differs from backup",
        "canonical_restore_database_mismatch",
      );
    }
    writeState(targetRoot, {
      abi: CANONICAL_BACKUP_ABI,
      operation_id: operationId,
      backup_id: verified.manifest.backup_id,
      archive_sha256: verified.archiveSha256,
      state: "restoring_database",
      updated_at: new Date().toISOString(),
    });
    const restoredDb = new Database(path.join(targetRoot, "store.sqlite"));
    restoredDb.pragma("foreign_keys = ON");
    restoredDb
      .prepare(
        "UPDATE storage_metadata SET state = 'recovery_required', " +
          "updated_at = ? WHERE singleton_id = 1",
      )
      .run(new Date().toISOString());
    restoredDb.close();
    options.fault?.("after-sqlite-restore");
    writeState(targetRoot, {
      abi: CANONICAL_BACKUP_ABI,
      operation_id: operationId,
      backup_id: verified.manifest.backup_id,
      archive_sha256: verified.archiveSha256,
      state: "restoring_objects",
      updated_at: new Date().toISOString(),
    });
    options.fault?.("during-object-extraction");
    writeState(targetRoot, {
      abi: CANONICAL_BACKUP_ABI,
      operation_id: operationId,
      backup_id: verified.manifest.backup_id,
      archive_sha256: verified.archiveSha256,
      state: "restoring_staging",
      updated_at: new Date().toISOString(),
    });
    options.fault?.("during-staging-restoration");
    writeState(targetRoot, {
      abi: CANONICAL_BACKUP_ABI,
      operation_id: operationId,
      backup_id: verified.manifest.backup_id,
      archive_sha256: verified.archiveSha256,
      state: "restoring_journals",
      updated_at: new Date().toISOString(),
    });
    options.fault?.("during-journal-restoration");
    copyExtractedData(extracted.dataPath, targetRoot, options.fault);
    writeState(targetRoot, {
      abi: CANONICAL_BACKUP_ABI,
      operation_id: operationId,
      backup_id: verified.manifest.backup_id,
      archive_sha256: verified.archiveSha256,
      state: "verifying",
      updated_at: new Date().toISOString(),
    });
    const state = verified.manifest.recovery_required
      ? "recovery_required"
      : "completed";
    const restored = new Database(path.join(targetRoot, "store.sqlite"));
    restored.pragma("foreign_keys = ON");
    try {
      const databaseIdentity = originalDatabaseIdentity;
      const audit = auditStorage(restored, targetPaths);
      if (
        audit.findings.some(
          (finding) =>
            finding.severity === "error" &&
            finding.code !== "schema_initialization_incomplete",
        )
      ) {
        throw new BackupError(
          "restored canonical storage audit failed",
          "canonical_restore_integrity",
        );
      }
      options.fault?.("before-final-integrity-verification");
      options.fault?.("after-verification-before-completion");
      if (state === "completed") {
        restored
          .prepare(
            "UPDATE storage_metadata SET state = 'ready', " +
              "updated_at = ? WHERE singleton_id = 1",
          )
          .run(new Date().toISOString());
      }
      const finalAudit = auditStorage(restored, targetPaths);
      if (state === "completed" && !finalAudit.ok) {
        throw new BackupError(
          "restored canonical storage failed final audit",
          "canonical_restore_integrity",
        );
      }
      const report: CanonicalRestoreReport = {
        databaseSha256: databaseIdentity.sha256,
        inventoryEntries: verified.manifest.inventory.length,
        objectsVerified: verified.manifest.object_count,
        stagingEntries: verified.manifest.staging_count,
        recoveryMaterialEntries:
          verified.manifest.required_recovery_material.length,
        integrity: finalAudit,
        databaseFingerprint: schemaFingerprint(restored).fingerprint,
      };
      writeState(targetRoot, {
        abi: CANONICAL_BACKUP_ABI,
        operation_id: operationId,
        backup_id: verified.manifest.backup_id,
        archive_sha256: verified.archiveSha256,
        state,
        updated_at: new Date().toISOString(),
      });
      return {
        backupId: verified.manifest.backup_id,
        targetRoot,
        state,
        operationId,
        report,
      };
    } finally {
      restored.close();
    }
  } catch (error) {
    if (fs.existsSync(targetRoot)) {
      try {
        writeState(targetRoot, {
          abi: CANONICAL_BACKUP_ABI,
          operation_id: operationId,
          backup_id: verified.manifest.backup_id,
          archive_sha256: verified.archiveSha256,
          state: "recovery_required",
          updated_at: new Date().toISOString(),
          error_code:
            error instanceof BackupError
              ? error.code
              : "canonical_restore_failed",
        });
      } catch {
        // Preserve the original restore error.
      }
    }
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      "canonical restore failed",
      "canonical_restore_failed",
      500,
      { cause: error },
    );
  } finally {
    resource?.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Returns the durable restore-journal path for a validated target root. */
export function restoreStateFile(root: string): string {
  return restoreStatePath(resolvedBackupPath(root, "target root"));
}
