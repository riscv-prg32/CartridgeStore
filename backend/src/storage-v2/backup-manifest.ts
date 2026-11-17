import fs from "node:fs";
import path from "node:path";

import type { BackendConfig } from "../config/env.js";
import { BackupError } from "../backup/format.js";
import {
  CANONICAL_BACKUP_ABI,
  CANONICAL_BACKUP_VERSION,
  DEFAULT_CANONICAL_BACKUP_LIMITS,
  type CanonicalBackupLimits,
  type CanonicalBackupManifest,
} from "./backup-contracts.js";
import { canonicalJson, hashText } from "./backup-validation.js";
import { TARGET_VERSION_TUPLE } from "./schema.js";

/** Serializes the manifest payload before its canonical hash is added. */
export function manifestPayload(
  manifest: Omit<CanonicalBackupManifest, "canonical_manifest_sha256">,
): string {
  return `${canonicalJson(manifest)}\n`;
}

/** Merges and validates canonical backup resource limits. */
export function canonicalBackupLimits(
  value?: Partial<CanonicalBackupLimits>,
): CanonicalBackupLimits {
  const result = { ...DEFAULT_CANONICAL_BACKUP_LIMITS, ...value };
  for (const [key, numberValue] of Object.entries(result)) {
    if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
      throw new BackupError(
        `canonical backup limit ${key} is invalid`,
        "canonical_backup_limit_invalid",
      );
    }
  }
  return result;
}

/** Maps canonical backup limits to the existing archive scanner config. */
export function canonicalBackupConfig(
  limits: CanonicalBackupLimits,
): BackendConfig {
  return {
    backupMaxArchiveBytes: limits.maxArchiveBytes,
    backupMaxExpandedBytes: limits.maxExpandedBytes,
    backupMaxEntryBytes: limits.maxEntryBytes,
    backupMaxManifestBytes: limits.maxManifestBytes,
    backupMaxEntries: limits.maxEntries,
    backupMaxPathBytes: limits.maxPathBytes,
    backupMaxPathDepth: limits.maxPathDepth,
    backupMaxCompressionRatio: limits.maxCompressionRatio,
  } as BackendConfig;
}

/** Validates a canonical backup or restore path without accepting the root. */
export function resolvedBackupPath(value: string, label: string): string {
  if (!value || value.trim() === "") {
    throw new BackupError(
      `${label} is required`,
      "canonical_backup_path_required",
    );
  }
  const result = path.resolve(value);
  if (result === path.parse(result).root) {
    throw new BackupError(
      `${label} may not be the filesystem root`,
      "canonical_backup_path_unsafe",
    );
  }
  return result;
}

/** Reads and authenticates a canonical backup manifest and its hash. */
export function readCanonicalManifest(
  extractedPath: string,
  limits: CanonicalBackupLimits,
): { readonly manifest: CanonicalBackupManifest; readonly bytes: Buffer } {
  const bytes = readManifestBytes(extractedPath, limits);
  const manifest = parseManifest(bytes);
  const withoutHash = JSON.parse(JSON.stringify(manifest)) as Record<
    string,
    unknown
  >;
  delete withoutHash.canonical_manifest_sha256;
  if (
    hashText(
      manifestPayload(
        withoutHash as Omit<
          CanonicalBackupManifest,
          "canonical_manifest_sha256"
        >,
      ),
    ) !== manifest.canonical_manifest_sha256
  ) {
    throw new BackupError(
      "canonical backup manifest hash is invalid",
      "canonical_backup_manifest_tampered",
    );
  }
  return { manifest, bytes };
}

function readManifestBytes(
  extractedPath: string,
  limits: CanonicalBackupLimits,
): Buffer {
  const bytes = fs.readFileSync(extractedPath);
  if (bytes.byteLength > limits.maxManifestBytes) {
    throw new BackupError(
      "canonical backup manifest is too large",
      "canonical_backup_manifest_too_large",
    );
  }
  return bytes;
}

function parseManifest(bytes: Buffer): CanonicalBackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new BackupError(
      "canonical backup manifest is invalid",
      "canonical_backup_manifest_invalid",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupError(
      "canonical backup manifest is invalid",
      "canonical_backup_manifest_invalid",
    );
  }
  const manifest = value as Partial<CanonicalBackupManifest>;
  if (
    manifest.abi !== CANONICAL_BACKUP_ABI ||
    manifest.format_version !== CANONICAL_BACKUP_VERSION ||
    manifest.application !== "prg32-cartridge-store" ||
    typeof manifest.backup_id !== "string" ||
    !manifest.snapshot ||
    !manifest.versions ||
    !Array.isArray(manifest.inventory) ||
    typeof manifest.canonical_manifest_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.canonical_manifest_sha256)
  ) {
    throw new BackupError(
      "canonical backup manifest is incompatible",
      "canonical_backup_manifest_incompatible",
    );
  }
  if (
    manifest.versions.schemaVersion !== TARGET_VERSION_TUPLE.schemaVersion ||
    manifest.versions.storageLayoutVersion !==
      TARGET_VERSION_TUPLE.storageLayoutVersion ||
    manifest.versions.publicationJournalVersion !==
      TARGET_VERSION_TUPLE.publicationJournalVersion ||
    manifest.versions.backupFormatVersion !==
      TARGET_VERSION_TUPLE.backupFormatVersion
  ) {
    throw new BackupError(
      "canonical backup version tuple is incompatible",
      "canonical_backup_version_incompatible",
    );
  }
  return manifest as CanonicalBackupManifest;
}
