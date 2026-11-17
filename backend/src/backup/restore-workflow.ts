import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { inspectSchema } from "../db/schema-inspection.js";
import {
  assertInside,
  BACKUP_ENCRYPTION_MAGIC,
  BACKUP_V2_ABI,
  BackupError,
  validateManifest,
} from "./format.js";
import { decryptBackup, extractZipArchive } from "./archive.js";
import type { SecretStore } from "../secrets/service.js";
import {
  availableBytes,
  clearManagedData,
  collectFiles,
  copyDataTree,
  directoryBytes,
  validateFilesystemReferences,
} from "./inventory.js";
import type {
  BackupFaultPoint,
  BackupServiceOptions,
  RestoreResult,
} from "./service-contracts.js";
import {
  acquireLock,
  jsonBytes,
  now,
  readJson,
  releaseLock,
  safeDirectory,
  writeAtomic,
} from "./operations.js";
import { restoreDatabase } from "./database.js";
import { validateStagedBackup } from "./validation.js";

const TERMINAL_STATES = new Set(["COMPLETED", "ROLLED_BACK", "FAILED"]);
const ROLLBACK_STATES = new Set([
  "RECOVERY_CREATED",
  "DB_REPLACE_STARTED",
  "DB_REPLACED",
  "FILESYSTEM_REPLACE_STARTED",
  "FILESYSTEM_REPLACED",
  "VERIFYING",
  "ROLLBACK_REQUIRED",
]);

type RestoreState =
  | "RECEIVED"
  | "STAGED"
  | "VALIDATED"
  | "RECOVERY_CREATED"
  | "DB_REPLACE_STARTED"
  | "DB_REPLACED"
  | "FILESYSTEM_REPLACE_STARTED"
  | "FILESYSTEM_REPLACED"
  | "VERIFYING"
  | "COMPLETED"
  | "ROLLBACK_REQUIRED"
  | "ROLLED_BACK"
  | "ROLLBACK_FAILED"
  | "FAILED";

interface RestoreJournal {
  readonly journalVersion: 1;
  readonly operationId: string;
  readonly state: RestoreState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly recoveryRelative?: string;
  readonly format?: string;
  readonly errorCode?: string;
}

interface RecoveryPoint {
  readonly directory: string;
  readonly databasePath: string;
  readonly dataPath: string;
}

interface RestoreWorkflowOptions {
  readonly config: BackendConfig;
  readonly database: Database.Database;
  readonly root: string;
  readonly stagingRoot: string;
  readonly recoveryRoot: string;
  readonly operationsRoot: string;
  readonly fault?: BackupServiceOptions["fault"];
  readonly secrets?: SecretStore;
}

/** Coordinates validation, journaled replacement and rollback of a backup. */
export class BackupRestoreWorkflow {
  private readonly fault: RestoreWorkflowOptions["fault"];

  constructor(private readonly options: RestoreWorkflowOptions) {
    this.fault = options.fault;
  }

  private hit(point: BackupFaultPoint): void {
    this.fault?.(point);
  }

  recoverIncomplete(): void {
    for (const entry of fs.readdirSync(this.options.operationsRoot, {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const journalPath = path.join(
        this.options.operationsRoot,
        entry.name,
        "operation.json",
      );
      if (!fs.existsSync(journalPath)) continue;
      const value = readJson(journalPath);
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        throw new BackupError(
          "backup recovery journal is invalid",
          "backup_recovery_journal_invalid",
          500,
        );
      }
      const journal = value as RestoreJournal;
      if (TERMINAL_STATES.has(journal.state)) continue;
      if (journal.state === "ROLLBACK_FAILED") {
        throw new BackupError(
          "backup requires manual recovery",
          "backup_manual_recovery_required",
          503,
        );
      }
      if (!journal.recoveryRelative) {
        writeAtomic(
          journalPath,
          jsonBytes({
            ...journal,
            state: "FAILED",
            updatedAt: now(),
            errorCode: "backup_interrupted_before_recovery",
          }),
        );
        continue;
      }
      const recovery = safeDirectory(
        this.options.root,
        journal.recoveryRelative,
      );
      const recoveryDatabase = path.join(recovery, "database.sqlite");
      const recoveryData = path.join(recovery, "data");
      try {
        const expected = inspectSchema(this.options.database);
        restoreDatabase(this.options.database, recoveryDatabase, expected);
        clearManagedData(
          this.options.root,
          this.options.config.databasePath,
        );
        copyDataTree(
          recoveryData,
          this.options.root,
          this.options.config.databasePath,
        );
        validateFilesystemReferences(this.options.root, this.options.database);
        writeAtomic(
          journalPath,
          jsonBytes({
            ...journal,
            state: "ROLLED_BACK",
            updatedAt: now(),
            errorCode: "backup_interrupted_recovered",
          }),
        );
      } catch (error) {
        writeAtomic(
          journalPath,
          jsonBytes({
            ...journal,
            state: "ROLLBACK_FAILED",
            updatedAt: now(),
            errorCode:
              error instanceof BackupError
                ? error.code
                : "backup_rollback_failed",
          }),
        );
        throw new BackupError(
          "backup recovery after interruption failed",
          "backup_rollback_failed",
          503,
          { cause: error },
        );
      }
    }
  }

  private operationPath(operationId: string): string {
    const directory = path.join(this.options.operationsRoot, operationId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return path.join(directory, "operation.json");
  }

  private writeJournal(operation: RestoreJournal): RestoreJournal {
    writeAtomic(
      this.operationPath(operation.operationId),
      jsonBytes(operation),
    );
    return operation;
  }

  private transition(
    operation: RestoreJournal,
    state: RestoreState,
    details: Partial<RestoreJournal> = {},
  ): RestoreJournal {
    return this.writeJournal({
      ...operation,
      ...details,
      state,
      updatedAt: now(),
    });
  }

  private async withMaintenanceLock<T>(callback: () => Promise<T>): Promise<T> {
    const lock = acquireLock(this.options.root);
    try {
      return await callback();
    } finally {
      releaseLock(lock);
    }
  }

  private recoveryPointPath(operationId: string): string {
    return path.join(this.options.recoveryRoot, operationId);
  }

  /** Creates the point-in-time data required for restore rollback. */
  async createRecoveryPoint(operationId: string): Promise<RecoveryPoint> {
    const directory = this.recoveryPointPath(operationId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const databasePath = path.join(directory, "database.sqlite");
    await this.options.database.backup(databasePath);
    const dataPath = path.join(directory, "data");
    fs.mkdirSync(dataPath, { recursive: true, mode: 0o700 });
    for (const file of collectFiles(
      this.options.root,
      this.options.config.databasePath,
      this.options.config,
    )) {
      const target = assertInside(
        dataPath,
        path.join(dataPath, file.relative),
      );
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(file.path, target);
      fs.chmodSync(target, 0o600);
    }
    writeAtomic(
      path.join(directory, "manifest.json"),
      jsonBytes({
        version: 1,
        created_at: now(),
        database: "database.sqlite",
        data_dir: "data/",
      }),
    );
    return { directory, databasePath, dataPath };
  }

  private replaceData(sourceData: string): void {
    clearManagedData(this.options.root, this.options.config.databasePath);
    copyDataTree(
      sourceData,
      this.options.root,
      this.options.config.databasePath,
    );
  }

  private rollback(operation: RestoreJournal, recovery: RecoveryPoint): void {
    const updated = this.transition(operation, "ROLLBACK_REQUIRED");
    try {
      const schema = inspectSchema(this.options.database);
      restoreDatabase(this.options.database, recovery.databasePath, schema);
      this.replaceData(recovery.dataPath);
      validateFilesystemReferences(this.options.root, this.options.database);
      this.transition(updated, "ROLLED_BACK", {
        errorCode: "backup_restore_rolled_back",
      });
    } catch (error) {
      this.transition(updated, "ROLLBACK_FAILED", {
        errorCode:
          error instanceof BackupError ? error.code : "backup_rollback_failed",
      });
      throw new BackupError(
        "backup rollback failed",
        "backup_rollback_failed",
        503,
        { cause: error },
      );
    }
  }

  async restore(uploadPath: string, password = ""): Promise<RestoreResult> {
    const job = fs.mkdtempSync(path.join(this.options.stagingRoot, "restore-"));
    let plainPath = uploadPath;
    let operation: RestoreJournal | undefined;
    try {
      if (
        fs.statSync(uploadPath).size >
        this.options.config.backupMaxArchiveBytes
      ) {
        throw new BackupError(
          "backup archive is too large",
          "backup_archive_too_large",
          413,
        );
      }
      const prefix = Buffer.alloc(BACKUP_ENCRYPTION_MAGIC.length);
      const prefixFd = fs.openSync(uploadPath, "r");
      try {
        fs.readSync(prefixFd, prefix, 0, prefix.length, 0);
      } finally {
        fs.closeSync(prefixFd);
      }
      if (prefix.equals(BACKUP_ENCRYPTION_MAGIC)) {
        if (!password) {
          throw new BackupError(
            "backup password is required",
            "backup_password_required",
          );
        }
        plainPath = path.join(job, "decrypted.zip");
        decryptBackup(uploadPath, plainPath, password);
      }
      const extractedRoot = path.join(job, "extracted");
      const extracted = extractZipArchive(
        plainPath,
        extractedRoot,
        this.options.config,
      );
      if (
        !fs.existsSync(extracted.manifestPath) ||
        !fs.existsSync(extracted.databasePath)
      ) {
        throw new BackupError(
          "backup is missing required files",
          "backup_required_file_missing",
        );
      }
      if (
        fs.statSync(extracted.manifestPath).size >
        this.options.config.backupMaxManifestBytes
      ) {
        throw new BackupError(
          "backup manifest is too large",
          "backup_manifest_too_large",
        );
      }
      let rawManifest: unknown;
      try {
        rawManifest = JSON.parse(
          fs.readFileSync(extracted.manifestPath, "utf8"),
        ) as unknown;
      } catch (error) {
        throw new BackupError(
          "backup manifest is invalid",
          "backup_manifest_invalid",
          400,
          { cause: error },
        );
      }
      const rawObject =
        rawManifest !== null &&
        typeof rawManifest === "object" &&
        !Array.isArray(rawManifest)
          ? (rawManifest as Record<string, unknown>)
          : {};
      const format = rawObject.abi === BACKUP_V2_ABI ? "v2" : "legacy-v1";
      const manifest = validateManifest(rawManifest, format);
      const operationId = "rst-" + crypto.randomUUID();
      operation = this.writeJournal({
        journalVersion: 1,
        operationId,
        state: "RECEIVED",
        createdAt: now(),
        updatedAt: now(),
        format,
      });
      operation = this.transition(operation, "STAGED");
      const validation = validateStagedBackup(extracted, manifest, {
        config: this.options.config,
        database: this.options.database,
        secrets: this.options.secrets,
      });
      operation = this.transition(operation, "VALIDATED");
      const currentBytes = directoryBytes(this.options.root);
      const stagedBytes = extracted.expandedBytes;
      if (
        availableBytes(this.options.root) <
        currentBytes + stagedBytes + this.options.config.backupMaxExpandedBytes
      ) {
        throw new BackupError(
          "insufficient storage for backup recovery",
          "backup_insufficient_storage",
          507,
        );
      }
      return await this.withMaintenanceLock(async () => {
        if (!operation) {
          throw new BackupError(
            "backup operation state is invalid",
            "backup_operation_invalid",
            500,
          );
        }
        const recovery = await this.createRecoveryPoint(operation.operationId);
        operation = this.transition(operation, "RECOVERY_CREATED", {
          recoveryRelative: path
            .relative(this.options.root, recovery.directory)
            .replaceAll(path.sep, "/"),
        });
        try {
          operation = this.transition(operation, "DB_REPLACE_STARTED");
          restoreDatabase(
            this.options.database,
            extracted.databasePath,
            validation.schema,
          );
          this.hit("after-db-replacement");
          operation = this.transition(operation, "DB_REPLACED");
          operation = this.transition(operation, "FILESYSTEM_REPLACE_STARTED");
          this.replaceData(extracted.dataPath);
          this.hit("after-filesystem-replacement");
          operation = this.transition(operation, "FILESYSTEM_REPLACED");
          operation = this.transition(operation, "VERIFYING");
          this.hit("before-verification");
          validateFilesystemReferences(this.options.root, this.options.database);
          const integrity = this.options.database
            .prepare("PRAGMA integrity_check")
            .get() as { integrity_check?: unknown };
          if (integrity.integrity_check !== "ok") {
            throw new BackupError(
              "restored database integrity check failed",
              "backup_post_restore_invalid",
            );
          }
          operation = this.transition(operation, "COMPLETED");
          return {
            operationId: operation.operationId,
            format: validation.format,
            state: "COMPLETED",
            entries: extracted.entries.size,
            expandedBytes: extracted.expandedBytes,
          };
        } catch (error) {
          this.rollback(operation, recovery);
          if (error instanceof BackupError) throw error;
          throw new BackupError(
            "backup restore failed",
            "backup_restore_failed",
            500,
            { cause: error },
          );
        }
      });
    } catch (error) {
      if (
        operation &&
        !TERMINAL_STATES.has(operation.state) &&
        !ROLLBACK_STATES.has(operation.state)
      ) {
        try {
          operation = this.transition(operation, "FAILED", {
            errorCode:
              error instanceof BackupError
                ? error.code
                : "backup_restore_failed",
          });
        } catch {
          // Preserve the original failure if journal finalization also fails.
        }
      }
      if (error instanceof BackupError) throw error;
      throw new BackupError(
        "backup restore failed",
        "backup_restore_failed",
        500,
        { cause: error },
      );
    } finally {
      fs.rmSync(job, { recursive: true, force: true });
    }
  }
}
