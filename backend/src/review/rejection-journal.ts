import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { encodePythonJson } from "../compatibility/serialization.js";
import { ReviewError, type ReviewErrorCode } from "./errors.js";

/** Root directory for durable rejection cleanup journals. */
export const REVIEW_OPERATION_ROOT = "review-operations";

const MAX_REVIEW_JOURNAL_BYTES = 512 * 1024;
const REVIEW_STATES = [
  "PREPARED",
  "DATABASE_UPDATED",
  "COMPLETED",
  "RECOVERY_REQUIRED",
] as const;

/** Durable states for a rejection cleanup operation. */
export type ReviewState = typeof REVIEW_STATES[number];

/** Persisted state needed to resume a rejection cleanup safely. */
export interface RejectionOperation {
  readonly journalVersion: 1;
  readonly operationId: string;
  readonly submissionId: number;
  readonly pendingRelative: string;
  readonly reviewer: { readonly id: number; readonly name: string };
  readonly state: ReviewState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function fail(
  message: string,
  code: ReviewErrorCode = "review_invalid_request",
  statusCode = 400,
): never {
  throw new ReviewError(message, code, statusCode);
}

/** Resolves a review path while rejecting traversal and symlink components. */
export function safeReviewPath(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(root, relative);
  if (
    candidate !== resolvedRoot &&
    !candidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    fail("review path escapes disposable root", "review_operation_failed", 500);
  }
  let current = resolvedRoot;
  for (const component of path
    .relative(resolvedRoot, candidate)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail("review path contains a symlink", "review_operation_failed", 500);
    }
  }
  return candidate;
}

/** Validates the pending directory recorded for a submission. */
export function safePendingRelative(
  value: string,
  submissionId: number,
): string {
  const expected = `pending/${submissionId}`;
  if (value !== expected) {
    fail("submission pending directory is unsafe", "review_operation_failed", 500);
  }
  return expected;
}

/** Ensures the rejection journal directory exists with private permissions. */
export function ensureRejectionJournalRoot(root: string): void {
  fs.mkdirSync(safeReviewPath(root, REVIEW_OPERATION_ROOT), {
    recursive: true,
    mode: 0o700,
  });
}

/** Writes a rejection operation journal atomically enough for recovery. */
export function writeRejectionJournal(
  root: string,
  operation: RejectionOperation,
): RejectionOperation {
  const directory = safeReviewPath(
    root,
    `${REVIEW_OPERATION_ROOT}/${operation.operationId}`,
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "operation.json");
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const data = Buffer.from(`${encodePythonJson(operation)}\n`, "utf8");
  if (data.byteLength > MAX_REVIEW_JOURNAL_BYTES) {
    fail("review journal is too large", "review_operation_failed", 500);
  }
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
  return operation;
}

/** Reads and validates a persisted rejection operation journal. */
export function readRejectionJournal(
  root: string,
  operationId: string,
): RejectionOperation {
  if (!/^rej-[a-f0-9-]{16,80}$/.test(operationId)) {
    fail("review operation id is invalid", "review_operation_failed", 500);
  }
  const target = safeReviewPath(
    root,
    `${REVIEW_OPERATION_ROOT}/${operationId}/operation.json`,
  );
  const stats = fs.lstatSync(target);
  if (!stats.isFile() || stats.size > MAX_REVIEW_JOURNAL_BYTES) {
    fail("review journal is corrupt", "review_operation_failed", 500);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
  } catch {
    fail("review journal is corrupt", "review_operation_failed", 500);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("review journal is corrupt", "review_operation_failed", 500);
  }
  const raw = parsed as Record<string, unknown>;
  if (
    raw.journalVersion !== 1 ||
    raw.operationId !== operationId ||
    !Number.isSafeInteger(raw.submissionId) ||
    typeof raw.pendingRelative !== "string" ||
    typeof raw.createdAt !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !REVIEW_STATES.includes(raw.state as ReviewState)
  ) {
    fail("review journal is corrupt", "review_operation_failed", 500);
  }
  const reviewer = raw.reviewer;
  if (
    reviewer === null ||
    typeof reviewer !== "object" ||
    Array.isArray(reviewer)
  ) {
    fail("review journal reviewer is corrupt", "review_operation_failed", 500);
  }
  const reviewerRecord = reviewer as Record<string, unknown>;
  if (
    !Number.isSafeInteger(reviewerRecord.id) ||
    typeof reviewerRecord.name !== "string" ||
    !reviewerRecord.name
  ) {
    fail("review journal reviewer is corrupt", "review_operation_failed", 500);
  }
  safePendingRelative(raw.pendingRelative, raw.submissionId as number);
  return raw as unknown as RejectionOperation;
}

/** Persists the next state of a rejection cleanup operation. */
export function transitionRejection(
  root: string,
  operation: RejectionOperation,
  state: ReviewState,
): RejectionOperation {
  return writeRejectionJournal(root, {
    ...operation,
    state,
    updatedAt: new Date().toISOString(),
  });
}
