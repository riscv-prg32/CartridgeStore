import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { BackupError } from "./format.js";
import { scanZipArchive } from "./archive.js";
import type { SecretStore } from "../secrets/service.js";
import {
  type BackupArtifact,
  type BackupServiceOptions,
  type RestoreResult,
} from "./service-contracts.js";
import { buildBackupArtifact } from "./exporter.js";
import {
  acquireLock,
  ensureDirectory,
  releaseLock,
} from "./operations.js";
import { BackupRestoreWorkflow } from "./restore-workflow.js";

export type {
  BackupArtifact,
  BackupFaultPoint,
  BackupServiceOptions,
  RestoreResult,
} from "./service-contracts.js";

const STAGING_DIRECTORY = ".prg32-backup-staging";
const RECOVERY_DIRECTORY = ".prg32-backup-recovery";
const OPERATIONS_DIRECTORY = "backup-operations";

export class BackupService {
  readonly root: string;
  private readonly stagingRoot: string;
  private readonly recoveryRoot: string;
  private readonly operationsRoot: string;
  private readonly restoreWorkflow: BackupRestoreWorkflow;
  private readonly secrets: SecretStore | undefined;

  constructor(
    private readonly config: BackendConfig,
    private readonly database: Database.Database,
    options: BackupServiceOptions = {}
  ) {
    this.root = path.resolve(config.storeDataDirectory);
    if (!fs.existsSync(this.root)) fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const rootStats = fs.lstatSync(this.root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new BackupError("backup store root is invalid", "backup_root_invalid", 500);
    this.stagingRoot = ensureDirectory(this.root, STAGING_DIRECTORY);
    this.recoveryRoot = ensureDirectory(this.root, RECOVERY_DIRECTORY);
    this.operationsRoot = ensureDirectory(this.root, OPERATIONS_DIRECTORY);
    this.restoreWorkflow = new BackupRestoreWorkflow({
      config,
      database,
      root: this.root,
      stagingRoot: this.stagingRoot,
      recoveryRoot: this.recoveryRoot,
      operationsRoot: this.operationsRoot,
      ...(options.fault ? { fault: options.fault } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
    });
    this.secrets = options.secrets;
  }

  recoverIncomplete(): void {
    this.restoreWorkflow.recoverIncomplete();
  }

  private async withMaintenanceLock<T>(callback: () => Promise<T>): Promise<T> {
    const lock = acquireLock(this.root);
    try {
      return await callback();
    } finally {
      releaseLock(lock);
    }
  }

  private createRecoveryPoint(operationId: string) {
    return this.restoreWorkflow.createRecoveryPoint(operationId);
  }

  async export(password = ""): Promise<BackupArtifact> {
    return this.withMaintenanceLock(() =>
      buildBackupArtifact(
        {
          config: this.config,
          database: this.database,
          root: this.root,
          stagingRoot: this.stagingRoot,
          ...(this.secrets ? { secrets: this.secrets } : {}),
        },
        password,
      ),
    );
  }

  async restore(uploadPath: string, password = ""): Promise<RestoreResult> {
    return this.restoreWorkflow.restore(uploadPath, password);
  }

  cleanupArtifact(artifact: BackupArtifact): void {
    try { fs.rmSync(artifact.path, { force: true }); } catch { /* download cleanup is best effort */ }
  }
}

export function backupFormatFromMagic(filePath: string): "encrypted-v2" | "zip" {
  const fd = fs.openSync(filePath, "r");
  try {
    const prefix = Buffer.alloc(20);
    const read = fs.readSync(fd, prefix, 0, prefix.length, 0);
    return read === 20 && prefix.toString("ascii") === "PRG32-BACKUP-ENC-1\n" ? "encrypted-v2" : "zip";
  } finally {
    fs.closeSync(fd);
  }
}

export function validateStagedZipForTests(zipPath: string, config: BackendConfig): number {
  return scanZipArchive(zipPath, config).entries.length;
}
