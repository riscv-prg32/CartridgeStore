import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { encodePythonJson } from "../compatibility/serialization.js";
import { validateCartridgeBinary } from "../submission/prg32.js";
import {
  catalogColophon,
  fail,
  reviewedImage,
  serializeJson,
  sha256,
} from "./publication-codecs.js";
import type {
  CatalogMutationAction,
  FaultPoint,
  PublicationOperation,
  PublicationState,
} from "./publication-contracts.js";
import {
  assertInside,
  ensureDirectory,
  readBounded,
  sha256File,
  writeAtomic,
} from "./publication-files.js";
import { compensatePublicationOperation } from "./publication-compensation.js";
import {
  indexForCatalogMutation,
  indexForPublication,
  PUBLICATION_INDEX_MAX_BYTES,
  loadPublicationIndex,
} from "./publication-index.js";

/** Relative root used for files staged during a publication operation. */
export const PUBLICATION_STAGING_ROOT = "publication-staging";

/** Relative root used for pending submission files. */
export const PUBLICATION_PENDING_ROOT = "pending";

/** Maximum cartridge image size accepted by the publication state machine. */
export const PUBLICATION_MAX_CARTRIDGE_BYTES = 128 * 1024 * 1024;

interface PublicationExecutionOptions {
  readonly root: string;
  readonly database: Database.Database;
  readonly fault?: (point: FaultPoint) => void;
  readonly transition: (
    operation: PublicationOperation,
    state: PublicationState,
    error?: { code: string; message: string },
  ) => PublicationOperation;
}

/** Executes, recovers and compensates durable publication operations. */
export class PublicationExecutionService {
  private readonly root: string;
  private readonly database: Database.Database;
  private readonly fault:
    | ((point: FaultPoint) => void)
    | undefined;
  private readonly transition: PublicationExecutionOptions["transition"];

  constructor(options: PublicationExecutionOptions) {
    this.root = options.root;
    this.database = options.database;
    this.fault = options.fault;
    this.transition = options.transition;
  }

  /** Stages a durable operation and preserves the granular recovery API. */
  stage(operation: PublicationOperation): PublicationOperation {
    if (operation.state === "STAGED" || operation.state === "VERIFIED") {
      return operation;
    }
    if (operation.state !== "PREPARED") {
      fail(
        "operation cannot be staged from its current state",
        "invalid_operation_transition",
      );
    }
    return this.stageUnlocked(operation);
  }

  /** Verifies staged files and preserves the granular recovery API. */
  verifyStaged(operation: PublicationOperation): PublicationOperation {
    if (operation.state === "VERIFIED") return operation;
    if (operation.state !== "STAGED") {
      fail(
        "operation cannot be verified from its current state",
        "invalid_operation_transition",
      );
    }
    return this.verifyUnlocked(operation);
  }

  /** Replaces published files after staged verification. */
  replaceFiles(operation: PublicationOperation): PublicationOperation {
    if (
      operation.state === "FILES_REPLACED" ||
      operation.state === "INDEX_REPLACED" ||
      operation.state === "DATABASE_UPDATED" ||
      operation.state === "COMPLETED"
    ) {
      return operation;
    }
    if (operation.state !== "VERIFIED") {
      fail(
        "files cannot be replaced from the current operation state",
        "invalid_operation_transition",
      );
    }
    return this.replaceFilesUnlocked(operation);
  }

  /** Replaces the public catalog index after file replacement. */
  replaceIndex(operation: PublicationOperation): PublicationOperation {
    if (
      operation.state === "INDEX_REPLACED" ||
      operation.state === "DATABASE_UPDATED" ||
      operation.state === "COMPLETED"
    ) {
      return operation;
    }
    if (operation.state !== "FILES_REPLACED") {
      fail(
        "index cannot be replaced from the current operation state",
        "invalid_operation_transition",
      );
    }
    return this.replaceIndexUnlocked(operation);
  }

  /** Updates the legacy submission row after public files are committed. */
  updateDatabase(operation: PublicationOperation): PublicationOperation {
    if (operation.state === "DATABASE_UPDATED" || operation.state === "COMPLETED") {
      return operation;
    }
    if (operation.state !== "INDEX_REPLACED") {
      fail(
        "database cannot be updated from the current operation state",
        "invalid_operation_transition",
      );
    }
    return this.updateDatabaseUnlocked(operation);
  }

  /** Completes an operation and removes its temporary files. */
  complete(operation: PublicationOperation): PublicationOperation {
    if (operation.state === "COMPLETED") {
      this.cleanupCompleted(operation);
      return operation;
    }
    if (operation.state !== "DATABASE_UPDATED") {
      fail(
        "operation cannot complete from the current state",
        "invalid_operation_transition",
      );
    }
    return this.completeUnlocked(operation);
  }

  /** Runs the complete publication state machine from a durable operation. */
  execute(initial: PublicationOperation): PublicationOperation {
    let operation = initial;
    if (operation.state === "COMPLETED") {
      this.cleanupCompleted(operation);
      return operation;
    }
    if (operation.state === "COMPENSATED") return operation;
    if (operation.state === "RECOVERY_REQUIRED" || operation.state === "FAILED") {
      fail("operation requires explicit recovery", "recovery_required");
    }
    if (operation.state === "PREPARED") operation = this.stageUnlocked(operation);
    if (operation.state === "STAGED") operation = this.verifyUnlocked(operation);
    if (operation.state === "VERIFIED") operation = this.replaceFilesUnlocked(operation);
    if (operation.state === "FILES_REPLACED") operation = this.replaceIndexUnlocked(operation);
    if (operation.state === "INDEX_REPLACED") operation = this.updateDatabaseUnlocked(operation);
    if (operation.state === "DATABASE_UPDATED") operation = this.completeUnlocked(operation);
    return operation;
  }

  /** Resumes or compensates one durable operation. */
  recover(
    operation: PublicationOperation,
    action: "resume" | "compensate",
  ): PublicationOperation {
    if (action === "resume") {
      if (
        operation.state === "RECOVERY_REQUIRED" ||
        operation.state === "FAILED"
      ) {
        fail("ambiguous operation cannot be resumed", "recovery_ambiguous");
      }
      return this.execute(operation);
    }
    return compensatePublicationOperation({
      root: this.root,
      database: this.database,
      operation,
      hit: (point) => this.hit(point),
      transition: (current, state) => this.transition(current, state),
    });
  }

  private stageUnlocked(operation: PublicationOperation): PublicationOperation {
    const loaded = loadPublicationIndex(this.root);
    if (loaded.hash !== operation.previousIndexSha256) {
      fail("catalog index changed after preparation", "publication_index_changed");
    }
    for (const variant of operation.variants) {
      if (
        operation.operationKind === "catalog" &&
        operation.catalogAction === "delete"
      ) {
        continue;
      }
      const source = assertInside(
        this.root,
        path.join(this.root, variant.sourceRelative),
        "pending file",
      );
      const pendingImage = readBounded(
        source,
        PUBLICATION_MAX_CARTRIDGE_BYTES,
        "pending_file_too_large",
      );
      const original = validateCartridgeBinary(pendingImage);
      const colophon =
        operation.operationKind === "catalog" &&
        operation.catalogAction === "update"
          ? catalogColophon(
              original.colophon,
              operation.reviewedMetadata as Record<string, unknown>,
            )
          : undefined;
      const image = reviewedImage(
        pendingImage,
        variant.architecture,
        operation.reviewedMetadata,
        colophon,
      ).image;
      if (sha256(image) !== variant.expectedSha256) {
        fail("pending file hash changed", "pending_hash_mismatch");
      }
      writeAtomic(this.root, variant.stagedRelative, image);
    }
    const index =
      operation.operationKind === "catalog"
        ? indexForCatalogMutation(
            loaded.index,
            operation.gameId,
            operation.version,
            operation.variants,
            operation.catalogAction as CatalogMutationAction,
            operation.createdAt,
          )
        : indexForPublication(
            loaded.index,
            operation.gameId,
            operation.version,
            operation.variants,
            operation.createdAt,
          );
    const indexBytes = serializeJson(index);
    if (sha256(indexBytes) !== operation.expectedIndexSha256) {
      fail("planned index identity changed", "publication_plan_mismatch");
    }
    this.hit("before-index-temp-write");
    writeAtomic(this.root, operation.indexStagedRelative, indexBytes);
    this.hit("after-index-temp-write");
    const current = this.transition(operation, "STAGED");
    this.hit("after-staging");
    return current;
  }

  private verifyUnlocked(operation: PublicationOperation): PublicationOperation {
    for (const variant of operation.variants) {
      if (
        operation.operationKind === "catalog" &&
        operation.catalogAction === "delete"
      ) {
        continue;
      }
      const image = readBounded(
        assertInside(
          this.root,
          path.join(this.root, variant.stagedRelative),
          "staged file",
        ),
        PUBLICATION_MAX_CARTRIDGE_BYTES,
        "staged_file_corrupt",
      );
      if (sha256(image) !== variant.expectedSha256) {
        fail("staged file hash mismatch", "staged_hash_mismatch");
      }
      validateCartridgeBinary(image);
    }
    const index = readBounded(
      assertInside(
        this.root,
        path.join(this.root, operation.indexStagedRelative),
        "staged index",
      ),
      PUBLICATION_INDEX_MAX_BYTES,
      "staged_index_corrupt",
    );
    if (sha256(index) !== operation.expectedIndexSha256) {
      fail("staged index hash mismatch", "staged_index_mismatch");
    }
    this.hit("after-staged-verification");
    return this.transition(operation, "VERIFIED");
  }

  private replaceFilesUnlocked(
    operation: PublicationOperation,
  ): PublicationOperation {
    for (const variant of operation.variants) {
      const target = assertInside(
        this.root,
        path.join(this.root, variant.targetRelative),
        "published target",
      );
      if (
        operation.operationKind === "catalog" &&
        operation.catalogAction === "delete"
      ) {
        const current = fs.existsSync(target) ? sha256File(target) : null;
        if (current !== variant.previousSha256) {
          fail("published target changed outside the operation", "publication_target_ambiguous");
        }
        const backup = assertInside(
          this.root,
          path.join(this.root, variant.backupRelative),
          "publication backup",
        );
        ensureDirectory(this.root, path.dirname(path.relative(this.root, backup)));
        if (!fs.existsSync(backup)) {
          fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
          if (sha256File(backup) !== variant.previousSha256) {
            fail("publication backup hash mismatch", "publication_backup_corrupt");
          }
        }
        this.hit("before-binary-replacement");
        fs.unlinkSync(target);
        this.hit("after-binary-replacement");
        continue;
      }
      ensureDirectory(this.root, path.dirname(path.relative(this.root, target)));
      const current = fs.existsSync(target) ? sha256File(target) : null;
      if (current === variant.expectedSha256) continue;
      if (current !== variant.previousSha256) {
        fail("published target changed outside the operation", "publication_target_ambiguous");
      }
      if (variant.previousSha256 !== null) {
        const backup = assertInside(
          this.root,
          path.join(this.root, variant.backupRelative),
          "publication backup",
        );
        if (!fs.existsSync(backup)) {
          ensureDirectory(this.root, path.dirname(path.relative(this.root, backup)));
          fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
        }
      }
      this.hit("before-binary-replacement");
      fs.renameSync(
        assertInside(
          this.root,
          path.join(this.root, variant.stagedRelative),
          "staged file",
        ),
        target,
      );
      this.hit("after-binary-replacement");
      if (sha256File(target) !== variant.expectedSha256) {
        fail("published file hash mismatch after replacement", "publication_hash_mismatch");
      }
    }
    return this.transition(operation, "FILES_REPLACED");
  }

  private replaceIndexUnlocked(
    operation: PublicationOperation,
  ): PublicationOperation {
    const indexPath = path.join(this.root, "index.json");
    const current = fs.existsSync(indexPath) ? sha256File(indexPath) : null;
    if (current !== operation.expectedIndexSha256) {
      if (current !== operation.previousIndexSha256) {
        fail("catalog index changed outside the operation", "publication_index_ambiguous");
      }
      if (current !== null) {
        const backup = assertInside(
          this.root,
          path.join(this.root, operation.indexBackupRelative),
          "index backup",
        );
        if (!fs.existsSync(backup)) {
          ensureDirectory(this.root, path.dirname(path.relative(this.root, backup)));
          fs.copyFileSync(indexPath, backup, fs.constants.COPYFILE_EXCL);
        }
      }
      this.hit("before-index-replacement");
      fs.renameSync(
        assertInside(
          this.root,
          path.join(this.root, operation.indexStagedRelative),
          "staged index",
        ),
        indexPath,
      );
      this.hit("after-index-replacement");
    }
    if (sha256File(indexPath) !== operation.expectedIndexSha256) {
      fail("catalog index hash mismatch", "publication_index_mismatch");
    }
    return this.transition(operation, "INDEX_REPLACED");
  }

  private updateDatabaseUnlocked(
    operation: PublicationOperation,
  ): PublicationOperation {
    this.hit("before-database-update");
    if (operation.operationKind === "catalog") {
      return this.transition(operation, "DATABASE_UPDATED");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(
          "SELECT status FROM cartridge_submissions WHERE id = ?",
        )
        .get(operation.submissionId) as { status?: string } | undefined;
      if (!row) fail("submission disappeared during publication", "submission_not_found");
      if (row.status === "pending") {
        if (operation.reviewedMetadata && operation.reviewer) {
          this.database
            .prepare(
              "UPDATE cartridge_submissions SET status = 'verified', " +
                "metadata_json = ?, reviewed_by_user_id = ?, reviewed_by = ?, " +
                "reviewed_at = datetime('now') WHERE id = ?",
            )
            .run(
              encodePythonJson(operation.reviewedMetadata),
              operation.reviewer.id,
              operation.reviewer.name,
              operation.submissionId,
            );
        } else {
          this.database
            .prepare(
              "UPDATE cartridge_submissions SET status = 'verified', " +
                "reviewed_by = 'publication-consistency', " +
                "reviewed_at = datetime('now') WHERE id = ?",
            )
            .run(operation.submissionId);
        }
      } else if (row.status !== "verified") {
        fail("submission state changed outside the operation", "submission_state_ambiguous");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    this.hit("after-database-update");
    return this.transition(operation, "DATABASE_UPDATED");
  }

  private completeUnlocked(operation: PublicationOperation): PublicationOperation {
    this.hit("before-completion");
    const completed = this.transition(operation, "COMPLETED");
    this.cleanupCompleted(completed);
    this.hit("after-completion");
    return completed;
  }

  private cleanupCompleted(operation: PublicationOperation): void {
    fs.rmSync(
      assertInside(
        this.root,
        path.join(
          this.root,
          `${PUBLICATION_STAGING_ROOT}/${operation.operationId}`,
        ),
        "staging directory",
      ),
      { recursive: true, force: true },
    );
    if (operation.operationKind !== "catalog") {
      fs.rmSync(
        assertInside(
          this.root,
          path.join(
            this.root,
            `${PUBLICATION_PENDING_ROOT}/${operation.submissionId}`,
          ),
          "pending directory",
        ),
        { recursive: true, force: true },
      );
    }
  }

  private hit(point: FaultPoint): void {
    this.fault?.(point);
  }
}
