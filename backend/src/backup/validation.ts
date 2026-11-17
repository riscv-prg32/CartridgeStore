import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import {
  inspectSchema,
  type SchemaSnapshot,
} from "../db/schema-inspection.js";
import {
  applyFederationMigrations,
  FEDERATION_TABLES,
} from "../db/federation-migrations.js";
import { applyApplicationMigrations } from "../db/application-migrations.js";
import type { SecretStore } from "../secrets/service.js";
import {
  BACKUP_V2_ABI,
  BackupError,
  isDerivedRelativePath,
  type BackupInventoryEntry,
  type BackupManifest,
  validateArchiveEntryPath,
} from "./format.js";
import {
  assertRegularFile,
  validateFilesystemReferences,
} from "./inventory.js";
import type { ExtractedArchive } from "./archive.js";
import { assertExpectedSchema, schemaFingerprint } from "./database.js";

/** Dependencies required to validate a staged application backup. */
export interface BackupValidationOptions {
  readonly config: BackendConfig;
  readonly database: Database.Database;
  readonly secrets: SecretStore | undefined;
}

/** Validates archive entries and checks their manifest inventory checksums. */
export function validateBackupInventory(
  extracted: ExtractedArchive,
  manifest: BackupManifest,
  config: BackendConfig,
): void {
  const allNames = new Set(
    [...extracted.entries.values()]
      .filter((entry) => !entry.directory)
      .map((entry) => entry.name),
  );
  const fileEntries = [...extracted.entries.values()].filter(
    (entry) => !entry.directory && entry.name !== "manifest.json",
  );
  const names = new Set(fileEntries.map((entry) => entry.name));
  if (!allNames.has("manifest.json") || !allNames.has("database.sqlite")) {
    throw new BackupError(
      "backup is missing required files",
      "backup_required_file_missing",
    );
  }
  for (const entry of fileEntries) {
    if (
      entry.name !== "manifest.json" &&
      entry.name !== "database.sqlite" &&
      !entry.name.startsWith("data/")
    ) {
      throw new BackupError(
        "backup contains an unexpected root entry",
        "backup_unexpected_entry",
      );
    }
  }
  if (manifest.abi !== BACKUP_V2_ABI) return;
  const inventory = new Map<string, BackupInventoryEntry>();
  for (const item of manifest.inventory) {
    const normalized = validateArchiveEntryPath(item.path, config);
    if (
      normalized.startsWith("data/") &&
      isDerivedRelativePath(normalized.slice("data/".length))
    ) {
      throw new BackupError(
        "backup inventory contains derived data",
        "backup_inventory_mismatch",
      );
    }
    if (inventory.has(normalized)) {
      throw new BackupError(
        "backup inventory contains duplicates",
        "backup_manifest_invalid",
      );
    }
    inventory.set(normalized, { ...item, path: normalized });
  }
  if (
    inventory.size !== names.size ||
    [...names].some((name) => !inventory.has(name))
  ) {
    throw new BackupError(
      "backup inventory does not match the archive",
      "backup_inventory_mismatch",
    );
  }
  for (const [name, item] of inventory) {
    const source = name === "database.sqlite"
      ? extracted.databasePath
      : path.join(extracted.dataPath, name.slice("data/".length));
    const stats = assertRegularFile(source, "backup_inventory_missing");
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(source))
      .digest("hex");
    if (stats.size !== item.size || digest !== item.sha256) {
      throw new BackupError(
        "backup inventory checksum mismatch",
        "backup_inventory_mismatch",
      );
    }
  }
}

/** Validates the extracted database, schema, secrets and filesystem references. */
export function validateStagedBackup(
  extracted: ExtractedArchive,
  manifest: BackupManifest,
  options: BackupValidationOptions,
): { readonly schema: SchemaSnapshot; readonly format: string } {
  validateBackupInventory(extracted, manifest, options.config);
  let liveSchema: SchemaSnapshot;
  try {
    liveSchema = inspectSchema(options.database);
  } catch (error) {
    throw new BackupError(
      "backup validation failed",
      "backup_validation_failed",
      400,
      { cause: error },
    );
  }
  const liveUsesFederation = liveSchema.tables.some((table) =>
    FEDERATION_TABLES.includes(table.name as typeof FEDERATION_TABLES[number]),
  );
  let legacyFingerprint: string | undefined;
  if (liveUsesFederation) {
    try {
      const writableStaged = new Database(extracted.databasePath, {
        fileMustExist: true,
      });
      try {
        legacyFingerprint = schemaFingerprint(inspectSchema(writableStaged));
        applyFederationMigrations(writableStaged);
      } finally {
        writableStaged.close();
      }
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError(
        "backup validation failed",
        "backup_validation_failed",
        400,
        { cause: error },
      );
    }
  }
  const liveHasApplicationExtensions = liveSchema.tables.some((table) =>
    [
      "application_settings",
      "admin_audit_events",
      "catalog_moderation",
      "setup_state",
      "webauthn_credentials",
      "webauthn_challenges",
    ].includes(table.name),
  );
  if (liveHasApplicationExtensions) {
    try {
      const writableStaged = new Database(extracted.databasePath, {
        fileMustExist: true,
      });
      try {
        applyApplicationMigrations(writableStaged);
      } finally {
        writableStaged.close();
      }
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError(
        "backup validation failed",
        "backup_validation_failed",
        400,
        { cause: error },
      );
    }
  }
  const staged = new Database(extracted.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const schema = assertExpectedSchema(
      staged,
      liveSchema,
      manifest,
      legacyFingerprint,
    );
    if (options.secrets) {
      let secretMetadata;
      try {
        secretMetadata = options.secrets.preflight(staged);
      } catch (error) {
        throw new BackupError(
          "backup secret key preflight failed",
          "backup_secret_key_preflight_failed",
          400,
          { cause: error },
        );
      }
      const declared = manifest.abi === BACKUP_V2_ABI
        ? manifest.secret_encryption
        : undefined;
      const declaredIds = declared?.required_key_ids ?? [];
      if (
        (secretMetadata.encryptedSettings > 0 && !declared) ||
        (declared &&
          (declared.encrypted_settings !== secretMetadata.encryptedSettings ||
            JSON.stringify(declaredIds) !==
              JSON.stringify(secretMetadata.keyIds)))
      ) {
        throw new BackupError(
          "backup secret metadata does not match database",
          "backup_secret_metadata_mismatch",
        );
      }
    }
    validateFilesystemReferences(extracted.dataPath, staged);
    return {
      schema,
      format: manifest.abi === BACKUP_V2_ABI ? "v2" : "legacy-v1",
    };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      "backup validation failed",
      "backup_validation_failed",
      400,
      { cause: error },
    );
  } finally {
    staged.close();
  }
}
