import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { BackupError } from "../backup/format.js";
import {
  BACKUP_CHUNK_BYTES,
  sha256File,
} from "./backup-validation.js";
import type { ArchiveEntrySource } from "./backup-archive.js";
import type { CanonicalBackupInventoryEntry } from "./backup-contracts.js";

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Resolves a canonical storage key under the selected backup root. */
export function pathForStorageKey(root: string, storageKey: string): string {
  if (
    !/^storage\/(objects|staging)\/[A-Za-z0-9._/-]+$/u.test(storageKey) ||
    storageKey.includes("..")
  ) {
    throw new BackupError(
      "canonical storage key is unsafe",
      "canonical_backup_storage_key_unsafe",
    );
  }
  const candidate = path.resolve(root, storageKey);
  if (!inside(candidate, root)) {
    throw new BackupError(
      "canonical storage key escapes the source root",
      "canonical_backup_storage_key_unsafe",
    );
  }
  return candidate;
}

/** Enumerates recovery and compatibility files for backup inventory. */
export function collectBackupFiles(
  root: string,
  relativeRoot: string,
  classification: CanonicalBackupInventoryEntry["classification"],
  kind: CanonicalBackupInventoryEntry["kind"],
  entries: ArchiveEntrySource[],
  inventory: CanonicalBackupInventoryEntry[],
  maxEntryBytes: number,
): void {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return;
  const walk = (directory: string): void => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, item.name);
      const relative = path
        .relative(root, candidate)
        .replaceAll(path.sep, "/");
      if (item.isSymbolicLink()) {
        throw new BackupError(
          "canonical backup rejects symlinks",
          "canonical_backup_symlink_rejected",
        );
      }
      if (item.isDirectory()) {
        walk(candidate);
        continue;
      }
      if (!item.isFile()) {
        throw new BackupError(
          "canonical backup rejects non-regular files",
          "canonical_backup_file_type_unsupported",
        );
      }
      const identity = sha256File(candidate);
      if (identity.sizeBytes > maxEntryBytes) {
        throw new BackupError(
          "canonical backup entry is too large",
          "canonical_backup_entry_too_large",
        );
      }
      const archivePath = `data/${relative}`;
      entries.push({ archivePath, sourcePath: candidate, ...identity });
      inventory.push({
        archivePath,
        sourceKey: relative,
        kind,
        sizeBytes: identity.sizeBytes,
        sha256: identity.sha256,
        classification,
      });
    }
  };
  walk(absoluteRoot);
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * Captures one source file through an open descriptor and rejects mutation or
 * replacement during the snapshot.
 */
function captureStableFile(
  sourcePath: string,
  targetPath: string,
  maxEntryBytes: number,
): void {
  const sourceBefore = fs.lstatSync(sourcePath);
  if (sourceBefore.isSymbolicLink() || !sourceBefore.isFile()) {
    throw new BackupError(
      "canonical backup rejects non-regular files",
      "canonical_backup_file_type_unsupported",
    );
  }
  if (sourceBefore.size > maxEntryBytes) {
    throw new BackupError(
      "canonical backup entry is too large",
      "canonical_backup_entry_too_large",
    );
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporary = `${targetPath}.tmp-${crypto.randomUUID()}`;
  const inputFd = fs.openSync(sourcePath, fs.constants.O_RDONLY);
  const outputFd = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  const buffer = Buffer.allocUnsafe(BACKUP_CHUNK_BYTES);
  let copied = 0;
  try {
    while (true) {
      const count = fs.readSync(inputFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      copied += count;
      if (copied > maxEntryBytes) {
        throw new BackupError(
          "canonical backup entry is too large",
          "canonical_backup_entry_too_large",
        );
      }
      fs.writeSync(outputFd, buffer, 0, count);
    }
    fs.fsyncSync(outputFd);
    const sourceAfter = fs.fstatSync(inputFd);
    if (!sameFileIdentity(sourceBefore, sourceAfter)) {
      throw new BackupError(
        "canonical backup source file changed during snapshot",
        "canonical_backup_source_changed",
        409,
      );
    }
    try {
      const currentPath = fs.lstatSync(sourcePath);
      if (!sameFileIdentity(sourceBefore, currentPath)) {
        throw new BackupError(
          "canonical backup source file was replaced during snapshot",
          "canonical_backup_source_changed",
          409,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // An unlink after opening is safe: the descriptor still references the
      // exact file that belonged to the SQLite snapshot.
    }
  } finally {
    fs.closeSync(inputFd);
    fs.closeSync(outputFd);
  }
  try {
    if (fs.existsSync(targetPath)) {
      throw new BackupError(
        "canonical backup snapshot contains a duplicate path",
        "canonical_backup_duplicate_entry",
      );
    }
    fs.renameSync(temporary, targetPath);
    fs.chmodSync(targetPath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

function captureDirectory(
  sourceRoot: string,
  targetRoot: string,
  relativeRoot: string,
  maxEntryBytes: number,
): void {
  const sourceDirectory = path.join(sourceRoot, relativeRoot);
  if (!fs.existsSync(sourceDirectory)) return;
  const walk = (directory: string): void => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = path.join(directory, item.name);
      const relative = path.relative(sourceRoot, sourcePath);
      if (item.isSymbolicLink()) {
        throw new BackupError(
          "canonical backup rejects symlinks",
          "canonical_backup_symlink_rejected",
        );
      }
      if (item.isDirectory()) {
        walk(sourcePath);
        continue;
      }
      if (!item.isFile()) {
        throw new BackupError(
          "canonical backup rejects non-regular files",
          "canonical_backup_file_type_unsupported",
        );
      }
      captureStableFile(
        sourcePath,
        path.join(targetRoot, relative),
        maxEntryBytes,
      );
    }
  };
  walk(sourceDirectory);
}

/** Captures SQLite-referenced objects and recovery evidence consistently. */
export function captureReferencedFiles(
  snapshot: Database.Database,
  sourceRoot: string,
  targetRoot: string,
  maxEntryBytes: number,
): void {
  const keys = new Set<string>();
  const objects = snapshot
    .prepare("SELECT storage_key FROM storage_objects ORDER BY object_id")
    .all() as Array<{ storage_key: string }>;
  for (const row of objects) keys.add(String(row.storage_key));
  const staging = snapshot
    .prepare(
      "SELECT staging_key FROM submission_artifacts " +
        "WHERE validation_state IN ('staged', 'validated') " +
        "ORDER BY submission_artifact_id",
    )
    .all() as Array<{ staging_key: string }>;
  for (const row of staging) keys.add(String(row.staging_key));
  for (const storageKey of keys) {
    const sourcePath = pathForStorageKey(sourceRoot, storageKey);
    const targetPath = pathForStorageKey(targetRoot, storageKey);
    captureStableFile(sourcePath, targetPath, maxEntryBytes);
  }
  // Recovery evidence and compatibility files are captured before inventorying
  // so the archive never mixes a live file with the SQLite snapshot.
  captureDirectory(
    sourceRoot,
    targetRoot,
    "storage/staging/operations",
    maxEntryBytes,
  );
  captureDirectory(sourceRoot, targetRoot, "journal", maxEntryBytes);
  captureDirectory(
    sourceRoot,
    targetRoot,
    "storage/quarantine",
    maxEntryBytes,
  );
  captureDirectory(sourceRoot, targetRoot, "compatibility", maxEntryBytes);
}
