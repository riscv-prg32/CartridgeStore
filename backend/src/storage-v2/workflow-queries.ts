/**
 * Canonical workflow submission queries and read models.
 */

import type Database from "better-sqlite3";

import type { ReviewErrorCode } from "../review/errors.js";
import type {
  OwnedSubmissionPage,
  SubmissionRecord
} from "../review/service.js";
import { submissionStatus } from "./workflow-codecs.js";
import {
  toSubmissionRecord,
  type CanonicalSubmissionRow
} from "./workflow-records.js";

const MAX_SUBMISSION_PAGE = 100;

type WorkflowFailure = (
  message: string,
  code?: ReviewErrorCode,
  status?: number
) => never;

function normalizeStatus(status: string | undefined): string | undefined {
  return status === undefined || status === "all"
    ? undefined
    : status === "pending"
      ? "pending_review"
      : status === "verified"
        ? "published"
        : status;
}

/** Lists canonical submissions using the workflow's public status aliases. */
export function listCanonicalSubmissions(
  database: Database.Database,
  status: string | undefined
): SubmissionRecord[] {
  const normalized = normalizeStatus(status);
  const rows =
    normalized === undefined
      ? database
          .prepare(
            "SELECT submission_id, cartridge_id, version, status, " +
              "submitted_by_user_id, submitted_by, reviewed_by_user_id, " +
              "reviewed_by, created_at, reviewed_at, published_release_id, " +
              "revision_of_submission_id, revision_number FROM submissions " +
              "ORDER BY created_at DESC, submission_id DESC LIMIT 1000"
          )
          .all()
      : database
          .prepare(
            "SELECT submission_id, cartridge_id, version, status, " +
              "submitted_by_user_id, submitted_by, reviewed_by_user_id, " +
              "reviewed_by, created_at, reviewed_at, published_release_id, " +
              "revision_of_submission_id, revision_number FROM submissions " +
              "WHERE status = ? ORDER BY created_at DESC, submission_id DESC " +
              "LIMIT 1000"
          )
          .all(normalized);
  return (rows as CanonicalSubmissionRow[]).map((row) =>
    toSubmissionRecord(database, row)
  );
}

/** Lists one user's canonical submissions with the established pagination. */
export function listOwnedCanonicalSubmissions(
  database: Database.Database,
  userId: number,
  status: string | undefined,
  page: number,
  perPage: number,
  fail: WorkflowFailure
): OwnedSubmissionPage {
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isSafeInteger(page) ||
    page <= 0 ||
    !Number.isSafeInteger(perPage) ||
    perPage <= 0 ||
    perPage > MAX_SUBMISSION_PAGE
  ) {
    fail("submission pagination is invalid");
  }
  const normalized = normalizeStatus(status);
  const where =
    normalized === undefined
      ? "submitted_by_user_id = ?"
      : "submitted_by_user_id = ? AND status = ?";
  const params = normalized === undefined ? [userId] : [userId, normalized];
  const total = Number(
    (
      database
        .prepare(`SELECT COUNT(*) AS total FROM submissions WHERE ${where}`)
        .get(...params) as { total: number }
    ).total
  );
  const pages = Math.ceil(total / perPage);
  const rows =
    normalized === undefined
      ? database
          .prepare(
            "SELECT submission_id, cartridge_id, version, status, " +
              "created_at, reviewed_at, (SELECT title FROM releases " +
              "WHERE release_id = submissions.published_release_id) AS title " +
              `FROM submissions WHERE ${where} ORDER BY created_at DESC, ` +
              "submission_id DESC LIMIT ? OFFSET ?"
          )
          .all(userId, perPage, (page - 1) * perPage)
      : database
          .prepare(
            "SELECT submission_id, cartridge_id, version, status, " +
              "created_at, reviewed_at, (SELECT title FROM releases " +
              "WHERE release_id = submissions.published_release_id) AS title " +
              `FROM submissions WHERE ${where} ORDER BY created_at DESC, ` +
              "submission_id DESC LIMIT ? OFFSET ?"
          )
          .all(
            userId,
            normalized,
            perPage,
            (page - 1) * perPage
          );
  return {
    submissions: (
      rows as Array<{
        submission_id: number;
        cartridge_id: string;
        version: string;
        status: string;
        title: string | null;
        created_at: string;
        reviewed_at: string | null;
      }>
    ).map((row) => ({
      id: row.submission_id,
      game_id: row.cartridge_id,
      title: row.title || row.cartridge_id,
      version: row.version,
      status: submissionStatus(row.status),
      created_at: row.created_at,
      reviewed_at: row.reviewed_at
    })),
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
