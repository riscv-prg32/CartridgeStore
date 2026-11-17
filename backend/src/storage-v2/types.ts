import type Database from "better-sqlite3";

export const TARGET_SCHEMA_VERSION = 2;
export const TARGET_STORAGE_LAYOUT_VERSION = 2;
export const TARGET_PUBLICATION_JOURNAL_VERSION = 1;
export const TARGET_BACKUP_FORMAT_VERSION = 3;
export const TARGET_APPLICATION = "prg32-cartridge-store";

export const OBJECT_KINDS = ["artifact", "media", "site_asset"] as const;
export type ObjectKind = typeof OBJECT_KINDS[number];

export const SUPPORTED_ARCHITECTURES = ["esp32c6", "qemu"] as const;
export type Architecture = typeof SUPPORTED_ARCHITECTURES[number];

export interface StoragePaths {
  readonly root: string;
  readonly databasePath: string;
  readonly storageRoot: string;
  readonly objectRoot: string;
  readonly artifactRoot: string;
  readonly mediaRoot: string;
  readonly siteAssetRoot: string;
  readonly objectTempRoot: string;
  readonly stagingRoot: string;
  readonly submissionStagingRoot: string;
  readonly operationStagingRoot: string;
  readonly quarantineRoot: string;
  readonly journalRoot: string;
  readonly publicationJournalRoot: string;
  readonly backupRoot: string;
  readonly compatibilityRoot: string;
}

export interface StorageDatabase {
  readonly sqlite: Database.Database;
  readonly paths: StoragePaths;
  readonly readOnly: boolean;
  close(): void;
}

export interface StorageObjectRecord {
  readonly objectId: string;
  readonly objectKind: ObjectKind;
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly state: "staged" | "available" | "quarantined" | "retired";
  readonly createdAt: string;
  readonly retiredAt: string | null;
  readonly createdByOperationId: string | null;
}

export interface ResolvedStorageObject {
  readonly record: StorageObjectRecord;
  readonly filePath: string;
  readonly fileDescriptor: number;
}

export interface IntegrityFinding {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly objectId?: string;
  readonly relationship?: string;
  readonly message: string;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly findings: readonly IntegrityFinding[];
  readonly counts: Readonly<Record<string, number>>;
}
