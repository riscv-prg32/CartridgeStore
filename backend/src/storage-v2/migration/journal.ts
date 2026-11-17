import fs from "node:fs";
import path from "node:path";

import { canonicalJson, parseBoundedJson, sha256Bytes, writeAtomic } from "../legacy/filesystem.js";
import { TARGET_SCHEMA_VERSION, TARGET_STORAGE_LAYOUT_VERSION } from "../types.js";
import { MIGRATION_ABI, type MigrationJournal, type MigrationPhase } from "./types.js";

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

function now(): string {
  return new Date().toISOString();
}

function journalPath(root: string, migrationId: string): string {
  const directory = path.join(root, "journal", "migrations");
  return path.join(directory, `${migrationId}.json`);
}

export function migrationJournalPath(root: string, migrationId: string): string {
  return journalPath(root, migrationId);
}

export function newMigrationJournal(migrationId: string, manifestSha256: string, sourceDatabaseFingerprint: string, sourceStorageFingerprint: string): MigrationJournal {
  const timestamp = now();
  return {
    abi: MIGRATION_ABI,
    migrationId,
    manifestSha256,
    sourceDatabaseFingerprint,
    sourceStorageFingerprint,
    targetSchemaVersion: TARGET_SCHEMA_VERSION,
    targetStorageLayoutVersion: TARGET_STORAGE_LAYOUT_VERSION,
    phase: "initialized",
    completedTables: [],
    completedArtifacts: [],
    completedMedia: [],
    completedSubmissions: [],
    completedTelemetry: [],
    checkpoints: ["target-initialized"],
    errors: [],
    recoveryState: "none",
    completionState: "incomplete",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function readMigrationJournal(root: string, migrationId: string): MigrationJournal | null {
  const filePath = journalPath(root, migrationId);
  if (!fs.existsSync(filePath)) return null;
  const value = parseBoundedJson(filePath, MAX_JOURNAL_BYTES, "migration journal");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("migration journal is invalid");
  const journal = value as MigrationJournal;
  if (journal.abi !== MIGRATION_ABI || journal.migrationId !== migrationId) throw new Error("migration journal identity is invalid");
  if (journal.targetSchemaVersion !== TARGET_SCHEMA_VERSION || journal.targetStorageLayoutVersion !== TARGET_STORAGE_LAYOUT_VERSION) throw new Error("migration journal target version is incompatible");
  return journal;
}

export function writeMigrationJournal(root: string, journal: MigrationJournal): void {
  const filePath = journalPath(root, journal.migrationId);
  writeAtomic(filePath, `${canonicalJson(journal)}\n`);
}

export function updateMigrationJournal(journal: MigrationJournal, patch: Partial<MigrationJournal>): MigrationJournal {
  return { ...journal, ...patch, updatedAt: now() };
}

export function appendCheckpoint(journal: MigrationJournal, checkpoint: string, phase?: MigrationPhase): MigrationJournal {
  return updateMigrationJournal(journal, {
    ...(phase ? { phase } : {}),
    checkpoints: [...new Set([...journal.checkpoints, checkpoint])]
  });
}

export function journalFingerprint(journal: MigrationJournal): string {
  return sha256Bytes(canonicalJson(journal));
}
