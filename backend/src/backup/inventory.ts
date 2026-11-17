import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { ReadonlyCatalog } from "../catalog/catalog.js";
import { assertInside, BackupError, isDerivedRelativePath, validateArchiveEntryPath } from "./format.js";

export interface LiveFile {
  readonly relative: string;
  readonly archivePath: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

function sha256(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isDatabaseArtifact(candidate: string, databasePath: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedDatabase = path.resolve(databasePath);
  return normalizedCandidate === normalizedDatabase || normalizedCandidate === normalizedDatabase + "-wal" || normalizedCandidate === normalizedDatabase + "-shm" || normalizedCandidate === normalizedDatabase + "-journal";
}

export function assertRegularFile(filePath: string, code = "backup_file_invalid"): fs.Stats {
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new BackupError("backup contains an invalid file", code);
  return stats;
}

export function collectFiles(root: string, databasePath: string, config: BackendConfig): LiveFile[] {
  const files: LiveFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(root, candidate).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        if (isDerivedRelativePath(relative)) continue;
        if (entry.isSymbolicLink()) throw new BackupError("backup data contains a symlink", "backup_symlink_rejected");
        walk(candidate);
        continue;
      }
      if (entry.isSymbolicLink()) throw new BackupError("backup data contains a symlink", "backup_symlink_rejected");
      if (!entry.isFile()) throw new BackupError("backup data contains an unsupported file", "backup_unsupported_file_type");
      if (isDerivedRelativePath(relative) || isDatabaseArtifact(candidate, databasePath)) continue;
      validateArchiveEntryPath("data/" + relative, config);
      const stats = assertRegularFile(candidate);
      if (stats.size > config.backupMaxEntryBytes) throw new BackupError("backup data entry is too large", "backup_entry_too_large");
      const bytes = fs.readFileSync(candidate);
      files.push({ relative, archivePath: "data/" + relative, path: candidate, size: bytes.byteLength, sha256: sha256(bytes) });
    }
  };
  walk(root);
  return files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

export function copyDataTree(sourceRoot: string, targetRoot: string, databasePath: string): void {
  if (!fs.existsSync(sourceRoot)) return;
  const sourceStats = fs.lstatSync(sourceRoot);
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) throw new BackupError("backup data root is invalid", "backup_data_root_invalid");
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, source).replaceAll(path.sep, "/");
      if (isDerivedRelativePath(relative)) continue;
      const target = assertInside(targetRoot, path.join(targetRoot, relative));
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) throw new BackupError("backup data contains a symlink", "backup_symlink_rejected");
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        walk(source);
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isFile()) throw new BackupError("backup data contains an unsupported file", "backup_unsupported_file_type");
      if (isDatabaseArtifact(target, databasePath)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
    }
  };
  walk(sourceRoot);
}

export function clearManagedData(root: string, databasePath: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (isDerivedRelativePath(entry.name) || isDatabaseArtifact(candidate, databasePath)) continue;
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

export function validateFilesystemReferences(root: string, database: Database.Database): void {
  try {
    const catalog = new ReadonlyCatalog(root);
    const games = catalog.listGames();
    for (const game of games) {
      const id = typeof game.id === "string" ? game.id : "";
      const versions = Array.isArray(game.versions) ? game.versions : [];
      for (const version of versions) {
        const selected = catalog.publicGame(id, String(version));
        const variants = selected.variants;
        if (variants === null || typeof variants !== "object" || Array.isArray(variants)) throw new BackupError("backup catalog variants are invalid", "backup_catalog_invalid");
        for (const architecture of Object.keys(variants)) catalog.resolveVariant(id, String(version), architecture);
      }
    }
    const rows = database.prepare("SELECT id, status, pending_dir, architectures_json FROM cartridge_submissions WHERE status = 'pending'").all() as Array<{ id: number; status: string; pending_dir: string; architectures_json: string }>;
    for (const row of rows) {
      if (!/^pending\/[1-9][0-9]*$/.test(row.pending_dir)) throw new BackupError("backup pending path is invalid", "backup_pending_reference_invalid");
      let architectures: unknown;
      try { architectures = JSON.parse(row.architectures_json) as unknown; } catch (error) {
        throw new BackupError("backup pending metadata is invalid", "backup_pending_reference_invalid", 400, { cause: error });
      }
      if (!Array.isArray(architectures)) throw new BackupError("backup pending metadata is invalid", "backup_pending_reference_invalid");
      for (const item of architectures) {
        if (item === null || typeof item !== "object" || Array.isArray(item) || typeof (item as Record<string, unknown>).stored !== "string") throw new BackupError("backup pending metadata is invalid", "backup_pending_reference_invalid");
        const stored = (item as Record<string, unknown>).stored as string;
        const target = assertInside(root, path.join(root, stored));
        const stats = assertRegularFile(target, "backup_pending_file_missing");
        if (stats.size <= 0) throw new BackupError("backup pending file is empty", "backup_pending_file_missing");
      }
    }
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("backup filesystem references are invalid", "backup_filesystem_invalid", 400, { cause: error });
  }
}

export function availableBytes(root: string): number {
  try {
    const stats = fs.statfsSync(root);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !isDerivedRelativePath(path.relative(root, candidate).replaceAll(path.sep, "/"))) walk(candidate);
      } else if (entry.isFile() && !entry.isSymbolicLink()) total += fs.statSync(candidate).size;
    }
  };
  walk(root);
  return total;
}
