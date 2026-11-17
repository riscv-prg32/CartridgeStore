import path from "node:path";

import type { BackendConfig } from "../config/env.js";

export const LEGACY_BACKUP_ABI = "prg32-cartridge-store-backup-1.0";
export const BACKUP_V2_ABI = "prg32-cartridge-store-backup-2.0";
export const BACKUP_V2_VERSION = 2;
export const BACKUP_ENCRYPTION_MAGIC = Buffer.from("PRG32-BACKUP-ENC-1\n", "ascii");

export const BACKUP_DERIVED_DIRECTORIES = new Set([
  ".prg32-backup-staging",
  ".prg32-backup-recovery",
  "backup-operations",
  "publication-operations",
  "publication-staging",
  "publication-backups"
]);

export const BACKUP_DERIVED_FILES = new Set(["publication.lock"]);

export interface BackupInventoryEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BackupManifestV1 {
  readonly abi: typeof LEGACY_BACKUP_ABI;
  readonly database: "database.sqlite";
  readonly data_dir: "data/";
}

export interface BackupManifestV2 {
  readonly abi: typeof BACKUP_V2_ABI;
  readonly format_version: typeof BACKUP_V2_VERSION;
  readonly created_at: string;
  readonly database: "database.sqlite";
  readonly data_dir: "data/";
  readonly application: "prg32-cartridge-store";
  readonly inventory: readonly BackupInventoryEntry[];
  readonly schema: {
    readonly fingerprint: string;
    readonly tables: readonly string[];
  };
  readonly secret_encryption?: {
    readonly envelope_version: 1;
    readonly required_key_ids: readonly string[];
    readonly encrypted_settings: number;
  };
}

export type BackupManifest = BackupManifestV1 | BackupManifestV2;

export type BackupFormat = "legacy-v1" | "v2" | "encrypted-v2";

export class BackupError extends Error {
  readonly code: string;
  readonly statusCode: number;
  override readonly cause?: unknown;

  constructor(message: string, code = "backup_invalid", statusCode = 400, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.statusCode = statusCode;
    this.cause = options?.cause;
  }
}

export function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupError(message, "backup_manifest_invalid");
  }
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new BackupError(message, "backup_manifest_invalid");
  return value;
}

export function normalizeArchivePath(raw: string, config: BackendConfig): { readonly path: string; readonly directory: boolean } {
  if (typeof raw !== "string" || raw.includes("\0")) {
    throw new BackupError("backup archive path is unsafe", "backup_unsafe_path");
  }
  const directory = raw.endsWith("/");
  const normalized = raw.replaceAll("\\", "/");
  const candidate = directory ? normalized.slice(0, -1) : normalized;
  if (!candidate || candidate.startsWith("/") || /^[A-Za-z]:[/\\]/.test(candidate)) {
    throw new BackupError("backup archive path is unsafe", "backup_unsafe_path");
  }
  const components = candidate.split("/");
  if (components.some((component) => !component || component === "." || component === "..")) {
    throw new BackupError("backup archive path is unsafe", "backup_unsafe_path");
  }
  if (Buffer.byteLength(normalized, "utf8") > config.backupMaxPathBytes || components.length > config.backupMaxPathDepth) {
    throw new BackupError("backup archive path is too long", "backup_path_too_long");
  }
  return { path: candidate, directory };
}

export function validateArchiveEntryPath(raw: string, config: BackendConfig): string {
  const normalized = normalizeArchivePath(raw, config);
  if (normalized.directory) return normalized.path;
  if (normalized.path !== "manifest.json" && normalized.path !== "manifest.sha256" && normalized.path !== "database.sqlite" && !normalized.path.startsWith("data/")) {
    throw new BackupError("backup contains an unexpected root entry", "backup_unexpected_entry");
  }
  return normalized.path;
}

export function validateManifest(value: unknown, format: "legacy-v1" | "v2"): BackupManifest {
  const manifest = object(value, "backup manifest is invalid");
  if (format === "legacy-v1") {
    if (manifest.abi !== LEGACY_BACKUP_ABI || manifest.database !== "database.sqlite" || manifest.data_dir !== "data/") {
      throw new BackupError("legacy backup manifest is incompatible", "backup_manifest_incompatible");
    }
    return { abi: LEGACY_BACKUP_ABI, database: "database.sqlite", data_dir: "data/" };
  }
  if (
    manifest.abi !== BACKUP_V2_ABI ||
    manifest.format_version !== BACKUP_V2_VERSION ||
    manifest.database !== "database.sqlite" ||
    manifest.data_dir !== "data/" ||
    manifest.application !== "prg32-cartridge-store" ||
    typeof manifest.created_at !== "string" ||
    !Array.isArray(manifest.inventory)
  ) {
    throw new BackupError("backup manifest is incompatible", "backup_manifest_incompatible");
  }
  const inventory = manifest.inventory.map((item) => {
    const record = object(item, "backup inventory is invalid");
    const inventoryPath = stringValue(record.path, "backup inventory path is invalid");
    const size = typeof record.size === "number" ? record.size : -1;
    const sha256 = record.sha256;
    if (!Number.isSafeInteger(size) || size < 0 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new BackupError("backup inventory is invalid", "backup_manifest_invalid");
    }
    return { path: inventoryPath, size, sha256 };
  });
  const schema = object(manifest.schema, "backup schema metadata is invalid");
  if (
    typeof schema.fingerprint !== "string" ||
    !Array.isArray(schema.tables) ||
    schema.tables.some((table) => typeof table !== "string")
  ) {
    throw new BackupError("backup schema metadata is invalid", "backup_manifest_invalid");
  }
  let secretEncryption: BackupManifestV2["secret_encryption"];
  if (manifest.secret_encryption !== undefined) {
    const value = object(manifest.secret_encryption, "backup secret metadata is invalid");
    const ids: unknown[] = Array.isArray(value.required_key_ids) ? value.required_key_ids as unknown[] : [];
    const validIds = ids.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id));
    if (value.envelope_version !== 1 || !Array.isArray(value.required_key_ids) || ids.length !== validIds.length || ids.length > 32 || new Set(validIds).size !== validIds.length || typeof value.encrypted_settings !== "number" || !Number.isSafeInteger(value.encrypted_settings) || value.encrypted_settings < 0 || value.encrypted_settings > 16) {
      throw new BackupError("backup secret metadata is invalid", "backup_manifest_invalid");
    }
    secretEncryption = { envelope_version: 1, required_key_ids: [...validIds].sort(), encrypted_settings: value.encrypted_settings };
  }
  return {
    abi: BACKUP_V2_ABI,
    format_version: BACKUP_V2_VERSION,
    created_at: manifest.created_at,
    database: "database.sqlite",
    data_dir: "data/",
    application: "prg32-cartridge-store",
    inventory,
    schema: { fingerprint: schema.fingerprint, tables: schema.tables },
    ...(secretEncryption ? { secret_encryption: secretEncryption } : {})
  };
}

export function assertInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new BackupError("backup path escapes its root", "backup_unsafe_path", 400);
  }
  return resolved;
}

export function isDerivedRelativePath(relative: string): boolean {
  const normalized = relative.replaceAll("\\", "/");
  const [first] = normalized.split("/");
  return BACKUP_DERIVED_FILES.has(normalized) || (first !== undefined && BACKUP_DERIVED_DIRECTORIES.has(first));
}
