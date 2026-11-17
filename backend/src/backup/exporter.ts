import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { inspectSchema } from "../db/schema-inspection.js";
import type { SecretStore } from "../secrets/service.js";
import {
  BACKUP_V2_ABI,
  BackupError,
  type BackupInventoryEntry,
} from "./format.js";
import { createZip, encryptBackup, scanZipArchive } from "./archive.js";
import { collectFiles } from "./inventory.js";
import { jsonBytes, now, sha256 } from "./operations.js";
import type { BackupArtifact } from "./service-contracts.js";
import { schemaFingerprint } from "./database.js";

/** Dependencies required to build one application backup artifact. */
export interface BackupExportOptions {
  readonly config: BackendConfig;
  readonly database: Database.Database;
  readonly root: string;
  readonly stagingRoot: string;
  readonly secrets?: SecretStore;
}

/** Creates, validates and optionally encrypts a v2 backup artifact. */
export async function buildBackupArtifact(
  options: BackupExportOptions,
  password: string,
): Promise<BackupArtifact> {
  const {
    config,
    database,
    root,
    secrets,
    stagingRoot,
  } = options;
  const job = fs.mkdtempSync(path.join(stagingRoot, "export-"));
  const databasePath = path.join(job, "database.sqlite");
  const archivePath = path.join(
    stagingRoot,
    "backup-" + crypto.randomUUID() + ".zip",
  );

  try {
    const secretMetadata = secrets?.preflight(database) ?? {
      keyIds: [],
      encryptedSettings: 0,
    };
    if (config.secretEncryptionEnabled && !password) {
      throw new BackupError(
        "encrypted backup password is required",
        "backup_encryption_required",
        400,
      );
    }

    await database.backup(databasePath);
    const databaseBytes = fs.readFileSync(databasePath);
    const dataFiles = collectFiles(root, config.databasePath, config);
    const inventory: BackupInventoryEntry[] = [
      {
        path: "database.sqlite",
        size: databaseBytes.byteLength,
        sha256: sha256(databaseBytes),
      },
      ...dataFiles.map((file) => ({
        path: file.archivePath,
        size: file.size,
        sha256: file.sha256,
      })),
    ];
    if (inventory.length + 1 > config.backupMaxEntries) {
      throw new BackupError(
        "backup contains too many entries",
        "backup_too_many_entries",
        413,
      );
    }
    const expandedBytes = inventory.reduce((sum, item) => sum + item.size, 0);
    if (expandedBytes > config.backupMaxExpandedBytes) {
      throw new BackupError(
        "backup expanded data is too large",
        "backup_expanded_too_large",
        413,
      );
    }

    const schema = inspectSchema(database);
    const manifest = {
      abi: BACKUP_V2_ABI,
      format_version: 2,
      created_at: now(),
      database: "database.sqlite",
      data_dir: "data/",
      application: "prg32-cartridge-store",
      inventory,
      schema: {
        fingerprint: schemaFingerprint(schema),
        tables: schema.tables.map((table) => table.name).sort(),
      },
      ...(secretMetadata.encryptedSettings > 0 ||
      config.secretEncryptionEnabled
        ? {
            secret_encryption: {
              envelope_version: 1,
              required_key_ids: secretMetadata.keyIds,
              encrypted_settings: secretMetadata.encryptedSettings,
            },
          }
        : {}),
    };
    const manifestBytes = jsonBytes(manifest);
    if (manifestBytes.byteLength > config.backupMaxManifestBytes) {
      throw new BackupError(
        "backup manifest is too large",
        "backup_manifest_too_large",
        413,
      );
    }

    const entries: Record<string, Uint8Array> = {
      "manifest.json": manifestBytes,
      "database.sqlite": databaseBytes,
    };
    for (const file of dataFiles) {
      entries[file.archivePath] = fs.readFileSync(file.path);
    }
    const archive = createZip(entries);
    if (archive.byteLength > config.backupMaxArchiveBytes) {
      throw new BackupError(
        "backup archive is too large",
        "backup_archive_too_large",
        413,
      );
    }
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    scanZipArchive(archivePath, config);
    if (!password) {
      return {
        path: archivePath,
        encrypted: false,
        filename: "prg32-cartridge-store-backup-v2.zip",
      };
    }

    const encryptedPath = archivePath + ".enc";
    encryptBackup(archivePath, encryptedPath, password);
    fs.rmSync(archivePath, { force: true });
    return {
      path: encryptedPath,
      encrypted: true,
      filename: "prg32-cartridge-store-backup-v2.zip.enc",
    };
  } finally {
    fs.rmSync(job, { recursive: true, force: true });
  }
}
