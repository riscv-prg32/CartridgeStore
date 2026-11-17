import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { ReviewError, type ReviewErrorCode } from "../review/errors.js";
import { expectedStorageKey } from "./objects.js";
import {
  promoteCanonicalObject,
  verifyCanonicalObject,
  type CanonicalObjectPlan,
} from "./workflow-objects.js";
import {
  materializeCanonicalPayloads,
  type CanonicalPayloadArtifact,
} from "./workflow-payloads.js";
import {
  object,
  parseJson,
  sha256,
} from "./workflow-codecs.js";
import type {
  CanonicalWorkflowFaultPoint,
} from "./workflow-contracts.js";
import {
  loadCanonicalArtifacts,
  safeSubmissionMetadata,
  type CanonicalArtifactRow,
} from "./workflow-records.js";
import {
  commitCanonicalVisibility,
  type CanonicalWorkflowManifest,
} from "./workflow-visibility.js";
import type { StorageDatabase } from "./types.js";

const WORKFLOW_JOURNAL_VERSION = 1;
const MAX_OPERATION_BYTES = 2 * 1024 * 1024;
type ObjectPlan = CanonicalObjectPlan;

interface OperationRow {
  readonly operation_id: string;
  readonly submission_id: number;
  readonly release_id: string | null;
  readonly state: string;
  readonly manifest_json: string;
}

interface WorkflowExecutionOptions {
  readonly root: string;
  readonly database: Database.Database;
  readonly paths: StorageDatabase["paths"];
  readonly fault?: (point: CanonicalWorkflowFaultPoint) => void;
}

function now(): string {
  return new Date().toISOString();
}

function fail(
  message: string,
  code: ReviewErrorCode = "review_operation_failed",
  status = 400,
): never {
  throw new ReviewError(message, code, status);
}

function inside(root: string, relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some(
      (part) => !part || part === "." || part === "..",
    ) ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    fail(
      "canonical staging path is unsafe",
      "review_operation_failed",
      500,
    );
  }
  const candidate = path.resolve(root, normalized);
  const rootPath = path.resolve(root);
  if (!candidate.startsWith(`${rootPath}${path.sep}`)) {
    fail(
      "canonical staging path escapes the disposable root",
      "review_operation_failed",
      500,
    );
  }
  let current = rootPath;
  for (const component of path
    .relative(rootPath, candidate)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail(
        "canonical staging path contains a symlink",
        "review_operation_failed",
        500,
      );
    }
  }
  return candidate;
}

function readStaged(root: string, row: CanonicalPayloadArtifact): Buffer {
  const target = inside(root, row.staging_key);
  const stats = fs.lstatSync(target);
  if (!stats.isFile() || stats.size !== row.size_bytes) {
    fail("staged artifact is missing or has changed", "review_operation_failed", 500);
  }
  const bytes = fs.readFileSync(target);
  if (sha256(bytes) !== row.sha256) {
    fail(
      "staged artifact integrity verification failed",
      "review_operation_failed",
      500,
    );
  }
  return bytes;
}

/** Executes and recovers durable canonical publication operations. */
export class CanonicalWorkflowExecutionService {
  private readonly root: string;
  private readonly database: Database.Database;
  private readonly paths: StorageDatabase["paths"];
  private readonly fault:
    | ((point: CanonicalWorkflowFaultPoint) => void)
    | undefined;

  constructor(options: WorkflowExecutionOptions) {
    this.root = options.root;
    this.database = options.database;
    this.paths = options.paths;
    this.fault = options.fault;
  }

  /** Executes one durable publication operation from its current state. */
  execute(operationId: string): void {
    const { row, manifest } = this.operation(operationId);
    if (row.state === "completed") return;
    const payloads = materializeCanonicalPayloads(
      manifest,
      this.artifactRows(manifest.submissionId),
      {
        readStaged: (artifact) => readStaged(this.root, artifact),
        safeMetadata: safeSubmissionMetadata,
        fail,
      },
    );
    if (row.state === "prepared" || row.state === "objects_staged") {
      for (const item of manifest.objects) {
        this.hit("before-object-promotion");
        if (
          !this.verifyFile({
            ...item,
            targetStorageKey: expectedStorageKey(
              item.objectKind,
              item.objectId,
              item.mediaType,
            ),
          })
        ) {
          const bytes = payloads.get(item.objectId);
          if (!bytes) {
            fail(
              "publication object payload is unavailable",
              "review_operation_failed",
              500,
            );
          }
          this.promote(item, bytes);
        } else {
          this.database
            .prepare(
              "UPDATE storage_objects SET state = 'available' WHERE object_id = ?",
            )
            .run(item.objectId);
        }
        this.database
          .prepare(
            "UPDATE publication_operation_items SET state = 'verified' " +
              "WHERE operation_id = ? AND expected_object_id = ?",
          )
          .run(operationId, item.objectId);
        this.transition(
          operationId,
          row.state === "prepared" ? "prepared" : "objects_staged",
          "objects_staged",
          "object_promoted",
        );
        this.hit("after-object-promotion");
      }
      this.transition(
        operationId,
        "objects_staged",
        "objects_verified",
        "objects_verified",
      );
    }
    const current = this.operation(operationId).row;
    if (current.state === "objects_verified") {
      commitCanonicalVisibility({
        database: this.database,
        manifest,
        operationId,
        now,
        fail,
        beforeVisibility: () => this.hit("before-visibility"),
        afterVisibility: () => this.hit("after-visibility"),
      });
    }
    const afterVisibility = this.operation(operationId).row;
    if (
      afterVisibility.state === "database_committed" ||
      afterVisibility.state === "cleanup_pending"
    ) {
      this.hit("before-completion");
      this.hit("during-staging-cleanup");
      const submissionDirectory = path.join(
        this.paths.submissionStagingRoot,
        String(manifest.submissionId),
      );
      if (fs.existsSync(submissionDirectory)) {
        fs.rmSync(submissionDirectory, { recursive: true, force: true });
      }
      this.transition(
        operationId,
        afterVisibility.state,
        "completed",
        "publication_completed",
      );
    }
  }

  /** Resumes all durable canonical publication operations after startup. */
  recoverIncomplete(): void {
    const rows = this.database
      .prepare(
        "SELECT operation_id, state FROM publication_operations " +
          "WHERE operation_kind = 'submission' AND state IN " +
          "('prepared', 'objects_staged', 'objects_verified', " +
          "'database_committed', 'cleanup_pending') ORDER BY created_at",
      )
      .all() as Array<{ operation_id: string; state: string }>;
    for (const row of rows) this.execute(row.operation_id);
    const corrupt = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM publication_operations " +
          "WHERE operation_kind = 'submission' AND state = 'recovery_required'",
      )
      .get() as { count: number };
    if (Number(corrupt.count) > 0) {
      throw new Error("canonical publication recovery is required");
    }
  }

  private artifactRows(id: number): CanonicalArtifactRow[] {
    return loadCanonicalArtifacts(this.database, id);
  }

  private operation(
    operationId: string,
  ): { row: OperationRow; manifest: CanonicalWorkflowManifest } {
    const row = this.database
      .prepare(
        "SELECT operation_id, submission_id, release_id, state, " +
          "manifest_json FROM publication_operations WHERE operation_id = ?",
      )
      .get(operationId) as OperationRow | undefined;
    if (!row) {
      fail("publication operation not found", "review_operation_failed", 500);
    }
    if (row.manifest_json.length > MAX_OPERATION_BYTES) {
      fail("publication operation is too large", "review_operation_failed", 500);
    }
    const manifest = object(
      parseJson(row.manifest_json, "publication manifest"),
      "publication manifest",
    ) as unknown as CanonicalWorkflowManifest;
    if (
      manifest.journalVersion !== WORKFLOW_JOURNAL_VERSION ||
      manifest.operationId !== operationId ||
      !Array.isArray(manifest.objects)
    ) {
      fail("publication journal is corrupt", "review_operation_failed", 500);
    }
    return { row, manifest };
  }

  private verifyFile(item: ObjectPlan): boolean {
    return verifyCanonicalObject(this.root, item);
  }

  private promote(item: ObjectPlan, bytes: Buffer): void {
    promoteCanonicalObject(
      {
        root: this.root,
        objectTempRoot: this.paths.objectTempRoot,
        database: this.database,
        fail,
      },
      item,
      bytes,
    );
  }

  private transition(
    operationId: string,
    fromState: string,
    toState: string,
    eventCode: string,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database
        .prepare(
          "SELECT state FROM publication_operations WHERE operation_id = ?",
        )
        .get(operationId) as { state?: string } | undefined;
      if (!current || current.state !== fromState) {
        this.database.exec("ROLLBACK");
        return;
      }
      const updatedAt = now();
      this.database
        .prepare(
          "UPDATE publication_operations SET state = ?, updated_at = ?, " +
            "completed_at = CASE WHEN ? = 'completed' THEN " +
            "COALESCE(completed_at, ?) ELSE completed_at END " +
            "WHERE operation_id = ?",
        )
        .run(
          toState,
          updatedAt,
          toState,
          toState === "completed" ? updatedAt : null,
          operationId,
        );
      this.database
        .prepare(
          "INSERT INTO publication_events(operation_id, from_state, to_state, " +
            "event_code, details_json, created_at) VALUES (?, ?, ?, ?, '{}', ?)",
        )
        .run(operationId, fromState, toState, eventCode, now());
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private hit(point: CanonicalWorkflowFaultPoint): void {
    this.fault?.(point);
  }
}
