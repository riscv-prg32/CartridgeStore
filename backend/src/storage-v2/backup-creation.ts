import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { BackupError } from "../backup/format.js";
import { auditStorage } from "./integrity.js";
import { isDisposablePath, openTargetStorage } from "./database.js";
import { TARGET_VERSION_TUPLE } from "./schema.js";
import {
  predictedCanonicalZipBytes,
  writeCanonicalZipArchive,
  type ArchiveEntrySource,
} from "./backup-archive.js";
import {
  CANONICAL_BACKUP_ABI,
  CANONICAL_BACKUP_OPERATIONAL_AUTHORIZATION,
  CANONICAL_BACKUP_AUTHORIZATION,
  CANONICAL_BACKUP_VERSION,
  type CanonicalBackupManifest,
  type CanonicalBackupOptions,
  type CanonicalBackupResult,
  type CanonicalBackupSnapshotMode,
} from "./backup-contracts.js";
import { writeDurable } from "./backup-restore-io.js";
import {
  canonicalBackupLimits,
  manifestPayload,
  resolvedBackupPath,
} from "./backup-manifest.js";
import { verifyCanonicalBackup } from "./backup-verification.js";
import {
  assertDatabase,
  canonicalJson,
  hashText,
  schemaFingerprint,
  sha256File,
} from "./backup-validation.js";
import { captureReferencedFiles } from "./backup-files.js";
import { buildBackupInventory } from "./backup-inventory.js";

const SQLITE_SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000;

function validateBackupAuthorization(
  value: string,
): "disposable" | "operational" {
  if (value === CANONICAL_BACKUP_AUTHORIZATION) return "disposable";
  if (value === CANONICAL_BACKUP_OPERATIONAL_AUTHORIZATION) {
    return "operational";
  }
  throw new BackupError(
    "explicit backup authorization is required",
    "canonical_backup_authorization_required",
    403,
  );
}

function snapshotMode(
  value: CanonicalBackupSnapshotMode | undefined,
): CanonicalBackupSnapshotMode {
  if (value === undefined || value === "exclusive" || value === "online") {
    return value ?? "exclusive";
  }
  throw new BackupError(
    "canonical backup snapshot mode is invalid",
    "canonical_backup_snapshot_mode_invalid",
    400,
  );
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Creates and independently verifies a canonical backup archive. */
export async function createCanonicalBackup(
  options: CanonicalBackupOptions,
): Promise<CanonicalBackupResult> {
  const authorizationKind = validateBackupAuthorization(options.authorization);
  const mode = snapshotMode(options.snapshotMode);
  if (mode === "exclusive" && !options.writerQuiesced) {
    throw new BackupError(
      "writer quiescence is required for canonical backup",
      "canonical_backup_writer_not_quiesced",
      409,
    );
  }
  const sourceRoot = resolvedBackupPath(options.sourceRoot, "source root");
  const outputPath = resolvedBackupPath(options.outputPath, "output path");
  if (
    (authorizationKind === "disposable" && !isDisposablePath(sourceRoot)) ||
    !fs.existsSync(path.join(sourceRoot, ".prg32-storage-v2"))
  ) {
    throw new BackupError(
      "canonical backup source must be an initialized storage root",
      "canonical_backup_source_not_disposable",
      403,
    );
  }
  if (inside(outputPath, sourceRoot)) {
    throw new BackupError(
      "backup output may not be inside the source root",
      "canonical_backup_output_unsafe",
    );
  }
  if (
    fs.existsSync(outputPath) ||
    fs.existsSync(`${outputPath}.complete.json`)
  ) {
    throw new BackupError(
      "completed backup output already exists",
      "canonical_backup_output_exists",
      409,
    );
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const limitValue = canonicalBackupLimits(options.limits);
  const resource = openTargetStorage(sourceRoot, "read-only");
  const backupId = crypto.randomUUID();
  const snapshotDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "prg32-storage-v2-snapshot-"),
  );
  const snapshotPath = path.join(snapshotDirectory, "database.sqlite");
  try {
    assertDatabase(resource.sqlite);
    const audit = auditStorage(resource.sqlite, resource.paths);
    if (!audit.ok) {
      throw new BackupError(
        "canonical source storage audit failed",
        "canonical_backup_source_integrity",
      );
    }
    options.fault?.("before-sqlite-snapshot");
    const snapshotDeadline = Date.now() + SQLITE_SNAPSHOT_TIMEOUT_MS;
    await resource.sqlite.backup(snapshotPath, {
      progress: () => {
        if (Date.now() > snapshotDeadline) {
          throw new BackupError(
            "canonical SQLite snapshot exceeded its time bound",
            "canonical_backup_snapshot_timeout",
            503,
          );
        }
        return 100;
      },
    });
    options.fault?.("after-sqlite-snapshot");
    const snapshot = new Database(snapshotPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assertDatabase(snapshot);
      const identity = sha256File(snapshotPath);
      const capturedRoot = path.join(snapshotDirectory, "captured");
      captureReferencedFiles(
        snapshot,
        sourceRoot,
        capturedRoot,
        limitValue.maxEntryBytes,
      );
      const built = buildBackupInventory({
        snapshot,
        sourceRoot: capturedRoot,
        maxEntryBytes: limitValue.maxEntryBytes,
        ...(options.fault ? { fault: options.fault } : {}),
      });
      const databaseEntry: ArchiveEntrySource = {
        archivePath: "database.sqlite",
        sourcePath: snapshotPath,
        ...identity,
      };
      const allInventory = [
        {
          archivePath: "database.sqlite",
          sourceKey: "store.sqlite",
          kind: "sqlite_snapshot" as const,
          sizeBytes: identity.sizeBytes,
          sha256: identity.sha256,
          classification: "required" as const,
        },
        ...built.inventory,
      ];
      const expanded = allInventory.reduce(
        (total, item) => total + item.sizeBytes,
        0,
      );
      if (expanded > limitValue.maxExpandedBytes) {
        throw new BackupError(
          "canonical backup expanded size is too large",
          "canonical_backup_expanded_too_large",
        );
      }
      const archiveInventorySha256 = hashText(canonicalJson(allInventory));
      const schema = schemaFingerprint(snapshot);
      const payloadEntries = [databaseEntry, ...built.entries];
      let predictedArchiveBytes = 0;
      let base: Omit<
        CanonicalBackupManifest,
        "canonical_manifest_sha256"
      >;
      let manifestHash = "";
      let manifestBytes = Buffer.alloc(0);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        base = {
          abi: CANONICAL_BACKUP_ABI,
          format_version: CANONICAL_BACKUP_VERSION,
          application: "prg32-cartridge-store",
          backup_id: backupId,
          created_at: new Date().toISOString(),
          snapshot: {
            identity: hashText(`${backupId}:${identity.sha256}`),
            database: "database.sqlite",
            size_bytes: identity.sizeBytes,
            sha256: identity.sha256,
          },
          versions: TARGET_VERSION_TUPLE,
          schema,
          inventory: allInventory,
          object_count: built.inventory.filter(
            (item) => item.kind === "object",
          ).length,
          object_kinds: built.objectKinds,
          staging_count: built.stagingCount,
          recovery_required: built.recoveryRequired,
          required_recovery_material: built.recoveryMaterial,
          aggregate_bytes: {
            expanded,
            archive: predictedArchiveBytes,
          },
          archive_inventory_sha256: archiveInventorySha256,
          verification_state: built.recoveryRequired
            ? "recovery_required"
            : "complete",
        };
        manifestHash = hashText(manifestPayload(base));
        const manifest: CanonicalBackupManifest = {
          ...base,
          canonical_manifest_sha256: manifestHash,
        };
        manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
        const nextPredicted = predictedCanonicalZipBytes(
          payloadEntries,
          manifestBytes,
        );
        if (nextPredicted === predictedArchiveBytes) break;
        predictedArchiveBytes = nextPredicted;
      }
      const finalManifest: CanonicalBackupManifest = {
        ...base!,
        canonical_manifest_sha256: manifestHash,
      };
      if (manifestBytes.byteLength > limitValue.maxManifestBytes) {
        throw new BackupError(
          "canonical backup manifest is too large",
          "canonical_backup_manifest_too_large",
        );
      }
      const archive = writeCanonicalZipArchive(
        outputPath,
        payloadEntries,
        manifestBytes,
        manifestHash,
        limitValue,
        options.fault,
      );
      if (archive.archiveBytes > limitValue.maxArchiveBytes) {
        throw new BackupError(
          "canonical backup archive is too large",
          "canonical_backup_archive_too_large",
        );
      }
      const verification = verifyCanonicalBackup(outputPath, {
        limits: limitValue,
      });
      const marker = `${outputPath}.complete.json`;
      writeDurable(
        marker,
        `${canonicalJson({
          abi: CANONICAL_BACKUP_ABI,
          backup_id: backupId,
          archive_sha256: verification.archiveSha256,
          archive_bytes: verification.archiveBytes,
          completed_at: new Date().toISOString(),
        })}\n`,
      );
      return {
        backupId,
        archivePath: outputPath,
        completionMarker: marker,
        archiveSha256: verification.archiveSha256,
        archiveBytes: verification.archiveBytes,
        manifest: finalManifest,
      };
    } finally {
      snapshot.close();
    }
  } catch (error) {
    try {
      if (
        fs.existsSync(outputPath) &&
        !fs.existsSync(`${outputPath}.complete.json`)
      ) {
        fs.renameSync(
          outputPath,
          `${outputPath}.incomplete-${crypto.randomUUID()}`,
        );
      }
    } catch {
      // Quarantine is best effort; preserve the original error.
    }
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      "canonical backup creation failed",
      "canonical_backup_failed",
      500,
      { cause: error },
    );
  } finally {
    resource.close();
    fs.rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}
