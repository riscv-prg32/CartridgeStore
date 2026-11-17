import type Database from "better-sqlite3";

import { BackupError } from "../backup/format.js";
import {
  type CanonicalBackupFaultPoint,
  type CanonicalBackupInventoryEntry,
} from "./backup-contracts.js";
import {
  type ArchiveEntrySource,
} from "./backup-archive.js";
import {
  collectBackupFiles,
  pathForStorageKey,
} from "./backup-files.js";
import { recoveryRequired, sha256File } from "./backup-validation.js";
import { expectedStorageKey } from "./objects.js";
import type { ObjectKind } from "./types.js";

/** Input boundary for canonical backup inventory construction. */
export interface BackupInventoryOptions {
  readonly snapshot: Database.Database;
  readonly sourceRoot: string;
  readonly maxEntryBytes: number;
  readonly fault?: (point: CanonicalBackupFaultPoint) => void;
}

/** Canonical archive entries and recovery material discovered in storage. */
export interface BackupInventory {
  readonly entries: ArchiveEntrySource[];
  readonly inventory: CanonicalBackupInventoryEntry[];
  readonly objectKinds: Record<ObjectKind, number>;
  readonly stagingCount: number;
  readonly recoveryMaterial: readonly string[];
  readonly recoveryRequired: boolean;
}

/** Builds the archive inventory from the canonical database and filesystem. */
export function buildBackupInventory(
  options: BackupInventoryOptions,
): BackupInventory {
  const { snapshot, sourceRoot, maxEntryBytes, fault } = options;
  const entries: ArchiveEntrySource[] = [];
  const inventory: CanonicalBackupInventoryEntry[] = [];
  const objectKinds: Record<ObjectKind, number> = {
    artifact: 0,
    media: 0,
    site_asset: 0,
  };
  const objects = snapshot
    .prepare(
      "SELECT object_id, object_kind, storage_key, sha256, size_bytes, " +
        "media_type FROM storage_objects ORDER BY object_id",
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of objects) {
    fault?.("during-object-inventory");
    const objectKind = String(row.object_kind) as ObjectKind;
    const objectId = String(row.object_id);
    const storageKey = String(row.storage_key);
    if (
      !(["artifact", "media", "site_asset"] as readonly string[]).includes(
        objectKind,
      )
    ) {
      throw new BackupError(
        "canonical object kind is invalid",
        "canonical_backup_object_invalid",
      );
    }
    if (
      expectedStorageKey(
        objectKind,
        objectId,
        String(row.media_type),
      ) !== storageKey
    ) {
      throw new BackupError(
        "canonical object storage key is not derived from identity",
        "canonical_backup_object_invalid",
      );
    }
    const sourcePath = pathForStorageKey(sourceRoot, storageKey);
    const identity = sha256File(sourcePath);
    if (
      identity.sizeBytes !== Number(row.size_bytes) ||
      identity.sha256 !== String(row.sha256)
    ) {
      throw new BackupError(
        "canonical object identity is inconsistent",
        "canonical_backup_object_integrity",
      );
    }
    const archivePath = `data/${storageKey}`;
    entries.push({ archivePath, sourcePath, ...identity });
    inventory.push({
      archivePath,
      sourceKey: storageKey,
      kind: "object",
      objectKind,
      objectId,
      storageKey,
      sizeBytes: identity.sizeBytes,
      sha256: identity.sha256,
      classification: "required",
    });
    objectKinds[objectKind] += 1;
  }

  const stagingRows = snapshot
    .prepare(
      "SELECT staging_key, submission_id, architecture, sha256, size_bytes " +
        "FROM submission_artifacts WHERE validation_state IN " +
        "('staged', 'validated') ORDER BY submission_artifact_id",
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of stagingRows) {
    const stagingKey = String(row.staging_key);
    const sourcePath = pathForStorageKey(sourceRoot, stagingKey);
    const identity = sha256File(sourcePath);
    if (
      identity.sizeBytes !== Number(row.size_bytes) ||
      identity.sha256 !== String(row.sha256)
    ) {
      throw new BackupError(
        "submission staging identity is inconsistent",
        "canonical_backup_staging_integrity",
      );
    }
    const archivePath = `data/${stagingKey}`;
    entries.push({ archivePath, sourcePath, ...identity });
    inventory.push({
      archivePath,
      sourceKey: stagingKey,
      kind: "submission_staging",
      objectId: String(row.submission_id),
      sizeBytes: identity.sizeBytes,
      sha256: identity.sha256,
      classification: "required",
    });
  }

  collectBackupFiles(
    sourceRoot,
    "storage/staging/operations",
    "recovery_required",
    "journal",
    entries,
    inventory,
    maxEntryBytes,
  );
  collectBackupFiles(
    sourceRoot,
    "journal",
    "recovery_required",
    "journal",
    entries,
    inventory,
    maxEntryBytes,
  );
  collectBackupFiles(
    sourceRoot,
    "storage/quarantine",
    "recovery_required",
    "quarantine",
    entries,
    inventory,
    maxEntryBytes,
  );
  collectBackupFiles(
    sourceRoot,
    "compatibility",
    "optional",
    "compatibility",
    entries,
    inventory,
    maxEntryBytes,
  );

  const duplicatePaths = new Set<string>();
  for (const item of inventory) {
    if (duplicatePaths.has(item.archivePath)) {
      throw new BackupError(
        "canonical backup contains duplicate identities",
        "canonical_backup_duplicate_entry",
      );
    }
    duplicatePaths.add(item.archivePath);
  }
  return {
    entries: entries.sort((left, right) =>
      left.archivePath.localeCompare(right.archivePath),
    ),
    inventory: inventory.sort((left, right) =>
      left.archivePath.localeCompare(right.archivePath),
    ),
    objectKinds,
    stagingCount: stagingRows.length,
    recoveryMaterial: inventory
      .filter((item) => item.classification === "recovery_required")
      .map((item) => item.archivePath),
    recoveryRequired: recoveryRequired(snapshot),
  };
}
