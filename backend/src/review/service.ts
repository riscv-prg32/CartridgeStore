import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { PublicationConsistencyService, applyReviewMetadata, type ReconciliationFinding } from "../consistency/publication.js";
import type { Principal } from "../auth/principal.js";
import { ReviewError, type ReviewErrorCode } from "./errors.js";
import {
  ensureRejectionJournalRoot,
  readRejectionJournal,
  REVIEW_OPERATION_ROOT,
  safePendingRelative,
  safeReviewPath,
  transitionRejection,
  writeRejectionJournal,
  type RejectionOperation,
} from "./rejection-journal.js";
import type { RuntimePolicy } from "../settings/runtime-policy.js";
import type { ApprovalNotifier } from "../email/notifications.js";

const MAX_REVIEW_SUBMISSIONS = 1000;
const MAX_OWNED_SUBMISSIONS_PER_PAGE = 100;
const OWNED_SUBMISSION_STATUSES = new Set(["pending", "verified", "rejected"]);

export interface SubmissionRecord {
  readonly id: number;
  readonly game_id: string;
  readonly version: string;
  readonly status: string;
  readonly submitted_by_user_id: number | null;
  readonly submitted_by: string;
  readonly reviewed_by_user_id: number | null;
  readonly reviewed_by: string;
  readonly pending_dir: string;
  readonly metadata_json: string;
  readonly architectures_json: string;
  readonly created_at: string;
  readonly reviewed_at: string | null;
  readonly metadata: Record<string, unknown>;
  readonly architectures: readonly Record<string, unknown>[];
  readonly revision_of_submission_id?: number | null;
  readonly revision_number?: number;
  readonly review_history?: readonly Record<string, unknown>[];
}

export interface OwnedSubmissionSummary {
  readonly id: number;
  readonly game_id: string;
  readonly title: string;
  readonly version: string;
  readonly status: string;
  readonly created_at: string;
  readonly reviewed_at: string | null;
}

export interface OwnedSubmissionPage {
  readonly submissions: readonly OwnedSubmissionSummary[];
  readonly pagination: {
    readonly page: number;
    readonly per_page: number;
    readonly total: number;
    readonly pages: number;
    readonly has_next: boolean;
    readonly has_prev: boolean;
    readonly next_page: number | null;
    readonly prev_page: number | null;
  };
}

export interface ReviewWorkflowService {
  list(status: string | undefined): SubmissionRecord[];
  listMine(userId: number, status: string | undefined, page?: number, perPage?: number): OwnedSubmissionPage;
  detail(submissionId: number): SubmissionRecord;
  approve(submissionId: number, metadataUpdates: Record<string, unknown>, principal: Principal, note?: string): SubmissionRecord;
  reject(submissionId: number, principal: Principal, note?: string): SubmissionRecord;
}

export type { ApprovalNotifier } from "../email/notifications.js";

type SubmissionRow = Omit<SubmissionRecord, "metadata" | "architectures">;

function fail(message: string, code: ReviewErrorCode = "review_invalid_request", statusCode = 400): never {
  throw new ReviewError(message, code, statusCode);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(message, "review_operation_failed", 500);
  return value as Record<string, unknown>;
}

function now(): string { return new Date().toISOString(); }

function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { fail(`${label} is malformed`, "review_operation_failed", 500); }
}

function parseSubmission(row: SubmissionRow): SubmissionRecord {
  const metadata = record(parseJson(row.metadata_json, "submission metadata"), "submission metadata is malformed");
  const architecturesValue = parseJson(row.architectures_json, "submission architectures");
  if (!Array.isArray(architecturesValue) || architecturesValue.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    fail("submission architectures are malformed", "review_operation_failed", 500);
  }
  return { ...row, metadata, architectures: architecturesValue as Record<string, unknown>[] };
}

function safeSubmissionId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail("submission id is invalid");
  return value;
}

function rowFor(database: Database.Database, submissionId: number): SubmissionRecord | null {
  const row = database.prepare("SELECT id, game_id, version, status, submitted_by_user_id, submitted_by, reviewed_by_user_id, reviewed_by, pending_dir, metadata_json, architectures_json, created_at, reviewed_at FROM cartridge_submissions WHERE id = ?").get(submissionId) as SubmissionRow | undefined;
  return row ? parseSubmission(row) : null;
}

function reviewerOf(principal: Principal): { readonly id: number; readonly name: string } {
  if (!principal.authenticated || principal.id === null || !Number.isSafeInteger(principal.id) || principal.id <= 0 || !principal.name.trim()) fail("reviewer authentication is required", "review_not_authorized", 401);
  return { id: principal.id, name: principal.name.trim() };
}

export interface ReviewServiceOptions {
  readonly database: Database.Database;
  readonly root: string;
  readonly maxSubmissions?: number;
  readonly publication?: PublicationConsistencyService;
  readonly fault?: (point: "after-rejection-database-update" | "after-rejection-cleanup") => void;
  readonly policy?: RuntimePolicy;
  readonly approvalNotifier?: ApprovalNotifier;
}

export class ReviewService {
  readonly root: string;
  private readonly database: Database.Database;
  private readonly maxSubmissions: number;
  readonly publication: PublicationConsistencyService;
  private readonly fault: ReviewServiceOptions["fault"];
  private readonly policy: RuntimePolicy | undefined;
  private readonly approvalNotifier: ApprovalNotifier | undefined;

  constructor(options: ReviewServiceOptions) {
    this.root = path.resolve(options.root);
    this.database = options.database;
    this.maxSubmissions = options.maxSubmissions ?? MAX_REVIEW_SUBMISSIONS;
    this.fault = options.fault;
    this.policy = options.policy;
    this.approvalNotifier = options.approvalNotifier;
    if (!fs.existsSync(this.root) || !fs.lstatSync(this.root).isDirectory() || fs.lstatSync(this.root).isSymbolicLink()) fail("review disposable root is invalid", "review_unavailable", 503);
    this.publication = options.publication ?? new PublicationConsistencyService({ root: this.root, database: this.database });
    ensureRejectionJournalRoot(this.root);
  }

  private hit(point: "after-rejection-database-update" | "after-rejection-cleanup"): void { this.fault?.(point); }

  list(status: string | undefined): SubmissionRecord[] {
    const normalized = status === undefined || status === "all" ? undefined : status;
    const rows = normalized === undefined
      ? this.database.prepare("SELECT id, game_id, version, status, submitted_by_user_id, submitted_by, reviewed_by_user_id, reviewed_by, pending_dir, metadata_json, architectures_json, created_at, reviewed_at FROM cartridge_submissions ORDER BY created_at DESC, id DESC LIMIT ?").all(this.maxSubmissions)
      : this.database.prepare("SELECT id, game_id, version, status, submitted_by_user_id, submitted_by, reviewed_by_user_id, reviewed_by, pending_dir, metadata_json, architectures_json, created_at, reviewed_at FROM cartridge_submissions WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(normalized, this.maxSubmissions);
    return (rows as SubmissionRow[]).map(parseSubmission);
  }

  listMine(userId: number, status: string | undefined, page = 1, perPage = 25): OwnedSubmissionPage {
    if (!Number.isSafeInteger(userId) || userId <= 0) fail("submission owner is invalid", "review_not_authorized", 403);
    if (!Number.isSafeInteger(page) || page <= 0) fail("page is invalid");
    if (!Number.isSafeInteger(perPage) || perPage <= 0 || perPage > MAX_OWNED_SUBMISSIONS_PER_PAGE) fail("per_page is invalid");
    const normalizedStatus = status === undefined || status === "all" ? undefined : status.trim().toLowerCase();
    if (normalizedStatus !== undefined && !OWNED_SUBMISSION_STATUSES.has(normalizedStatus)) fail("status is invalid");

    const where = normalizedStatus === undefined
      ? "WHERE submitted_by_user_id = ?"
      : "WHERE submitted_by_user_id = ? AND status = ?";
    const countParameters = normalizedStatus === undefined ? [userId] : [userId, normalizedStatus];
    const total = Number((this.database.prepare(`SELECT COUNT(*) AS total FROM cartridge_submissions ${where}`).get(...countParameters) as { total: number }).total);
    const pages = Math.ceil(total / perPage);
    const offset = (page - 1) * perPage;
    const rows = normalizedStatus === undefined
      ? this.database.prepare(`SELECT id, game_id, version, status, metadata_json, created_at, reviewed_at FROM cartridge_submissions ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(userId, perPage, offset)
      : this.database.prepare(`SELECT id, game_id, version, status, metadata_json, created_at, reviewed_at FROM cartridge_submissions ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(userId, normalizedStatus, perPage, offset);
    const submissions = (rows as Array<{ id: number; game_id: string; version: string; status: string; metadata_json: string; created_at: string; reviewed_at: string | null }>).map((row) => {
      const metadata = record(parseJson(row.metadata_json, "submission metadata"), "submission metadata is malformed");
      const title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title : row.game_id;
      return { id: row.id, game_id: row.game_id, title, version: row.version, status: row.status, created_at: row.created_at, reviewed_at: row.reviewed_at };
    });
    return {
      submissions,
      pagination: {
        page,
        per_page: perPage,
        total,
        pages,
        has_next: page < pages,
        has_prev: page > 1 && pages > 0,
        next_page: page < pages ? page + 1 : null,
        prev_page: page > 1 && pages > 0 ? page - 1 : null
      }
    };
  }

  detail(submissionId: number): SubmissionRecord {
    const row = rowFor(this.database, safeSubmissionId(submissionId));
    if (!row) fail("submission not found", "review_not_found", 404);
    return row;
  }

  approve(submissionId: number, metadataUpdates: Record<string, unknown>, principal: Principal): SubmissionRecord {
    const id = safeSubmissionId(submissionId);
    const reviewer = reviewerOf(principal);
    const row = rowFor(this.database, id);
    if (!row) fail("submission not found", "review_not_found", 404);
    if (row.status !== "pending") fail("submission is not pending", "review_state_conflict");
    const reviewedMetadata = applyReviewMetadata(row.metadata, metadataUpdates);
    try {
      this.publication.publish(id, { metadata: reviewedMetadata, reviewer });
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      throw new ReviewError("review operation failed", "review_operation_failed", 500, { cause: error });
    }
    const approved = this.detail(id);
    this.approvalNotifier?.(approved, this.database).catch(() => undefined);
    return approved;
  }

  reject(submissionId: number, principal: Principal, note = ""): SubmissionRecord {
    const id = safeSubmissionId(submissionId);
    const reviewer = reviewerOf(principal);
    if (this.policy?.requireReviewNoteOnRejection() && note.trim().length === 0) fail("a rejection note is required");
    return this.publication.runSerialized(() => {
      const row = rowFor(this.database, id);
      if (!row) fail("submission not found", "review_not_found", 404);
      if (row.status !== "pending") fail("submission is not pending", "review_state_conflict");
      const operation: RejectionOperation = {
        journalVersion: 1,
        operationId: `rej-${crypto.randomUUID()}`,
        submissionId: id,
        pendingRelative: safePendingRelative(row.pending_dir, id),
        reviewer,
        state: "PREPARED",
        createdAt: now(),
        updatedAt: now()
      };
      writeRejectionJournal(this.root, operation);
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const current = rowFor(this.database, id);
        if (!current || current.status !== "pending") fail("submission is not pending", "review_state_conflict");
        this.database.prepare("UPDATE cartridge_submissions SET status = 'rejected', reviewed_by_user_id = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(reviewer.id, reviewer.name, id);
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.inTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
      const updated = transitionRejection(this.root, operation, "DATABASE_UPDATED");
      this.hit("after-rejection-database-update");
      safePendingRelative(updated.pendingRelative, id);
      fs.rmSync(safeReviewPath(this.root, updated.pendingRelative), { recursive: true, force: true });
      this.hit("after-rejection-cleanup");
      transitionRejection(this.root, updated, "COMPLETED");
      return this.detail(id);
    });
  }

  recoverRejection(operationId: string): RejectionOperation {
    return this.publication.runSerialized(() => {
      let operation = readRejectionJournal(this.root, operationId);
      const row = rowFor(this.database, operation.submissionId);
      if (!row) fail("submission not found", "review_operation_failed", 500);
      if (operation.state === "COMPLETED") return operation;
      if (operation.state === "PREPARED") {
        if (row.status === "pending") {
          this.database.exec("BEGIN IMMEDIATE");
          try {
            this.database.prepare("UPDATE cartridge_submissions SET status = 'rejected', reviewed_by_user_id = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(operation.reviewer.id, operation.reviewer.name, operation.submissionId);
            this.database.exec("COMMIT");
          } catch (error) { if (this.database.inTransaction) this.database.exec("ROLLBACK"); throw error; }
        } else if (row.status !== "rejected") fail("rejection operation is ambiguous", "review_state_conflict");
        operation = transitionRejection(this.root, operation, "DATABASE_UPDATED");
      } else if (operation.state !== "DATABASE_UPDATED") fail("rejection operation requires manual recovery", "review_state_conflict");
      fs.rmSync(safeReviewPath(this.root, operation.pendingRelative), { recursive: true, force: true });
      return transitionRejection(this.root, operation, "COMPLETED");
    });
  }

  reconcile(): ReconciliationFinding[] {
    const findings: ReconciliationFinding[] = [];
    const directory = safeReviewPath(this.root, REVIEW_OPERATION_ROOT);
    if (!fs.existsSync(directory)) return findings;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        findings.push({ code: "UNSAFE_REVIEW_OBJECT", classification: "CORRUPT", message: "review operation workspace contains a symlink", path: `${REVIEW_OPERATION_ROOT}/${entry.name}` });
        continue;
      }
      if (!entry.isDirectory()) continue;
      try {
        const operation = readRejectionJournal(this.root, entry.name);
        if (operation.state !== "COMPLETED") findings.push({ code: "INCOMPLETE_REJECTION_CLEANUP", classification: operation.state === "RECOVERY_REQUIRED" ? "AMBIGUOUS" : "RECOVERABLE", message: `rejection operation is ${operation.state}`, operationId: operation.operationId, submissionId: operation.submissionId });
        const row = rowFor(this.database, operation.submissionId);
        if (!row) findings.push({ code: "REJECTION_SUBMISSION_MISSING", classification: "CORRUPT", message: "rejection operation references a missing submission", operationId: operation.operationId, submissionId: operation.submissionId });
        else if (operation.state === "COMPLETED" && row.status !== "rejected") findings.push({ code: "REJECTION_STATUS_MISMATCH", classification: "AMBIGUOUS", message: "completed rejection does not match submission status", operationId: operation.operationId, submissionId: operation.submissionId });
        else if (operation.state === "COMPLETED" && fs.existsSync(safeReviewPath(this.root, operation.pendingRelative))) findings.push({ code: "REJECTED_SUBMISSION_WITH_PENDING_ARTIFACTS", classification: "RECOVERABLE", message: "rejected submission still has pending artifacts", operationId: operation.operationId, submissionId: operation.submissionId, path: operation.pendingRelative });
      } catch (error) {
        findings.push({ code: "REJECTION_JOURNAL_CORRUPT", classification: "CORRUPT", message: error instanceof Error ? error.message : "rejection journal is corrupt", operationId: entry.name });
      }
    }
    return findings;
  }
}
