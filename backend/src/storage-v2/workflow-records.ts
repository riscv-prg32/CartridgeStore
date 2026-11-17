import type Database from "better-sqlite3";

import type { ReviewErrorCode } from "../review/errors.js";
import type { SubmissionRecord } from "../review/service.js";
import { json, object, parseJson, submissionStatus } from "./workflow-codecs.js";
import type { CanonicalPayloadArtifact } from "./workflow-payloads.js";

/** Persisted submission row used by the canonical workflow read model. */
export interface CanonicalSubmissionRow {
  readonly submission_id: number;
  readonly cartridge_id: string;
  readonly version: string;
  readonly status: string;
  readonly submitted_by_user_id: number | null;
  readonly submitted_by: string;
  readonly reviewed_by_user_id: number | null;
  readonly reviewed_by: string;
  readonly created_at: string;
  readonly reviewed_at: string | null;
  readonly published_release_id: string | null;
  readonly revision_of_submission_id: number | null;
  readonly revision_number: number;
}

/** Persisted artifact row used by the canonical workflow read model. */
export interface CanonicalArtifactRow extends CanonicalPayloadArtifact {
  readonly submission_artifact_id: string;
  readonly submission_id: number;
  readonly source_filename: string;
  readonly media_type: string;
  readonly validation_state: string;
  readonly metadata_json: string;
  readonly colophon_json: string | null;
}

type Failure = (
  message: string,
  code?: ReviewErrorCode,
  status?: number,
) => never;

const SUBMISSION_COLUMNS =
  "submission_id, cartridge_id, version, status, " +
  "submitted_by_user_id, submitted_by, reviewed_by_user_id, reviewed_by, " +
  "created_at, reviewed_at, published_release_id, " +
  "revision_of_submission_id, revision_number";

/** Loads one canonical submission row or raises the public not-found error. */
export function loadCanonicalSubmission(
  database: Database.Database,
  id: number,
  fail: Failure,
): CanonicalSubmissionRow {
  const row = database
    .prepare(
      `SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE submission_id = ?`,
    )
    .get(id) as CanonicalSubmissionRow | undefined;
  if (!row) fail("submission not found", "review_not_found", 404);
  return row;
}

/** Loads the artifacts belonging to one canonical submission. */
export function loadCanonicalArtifacts(
  database: Database.Database,
  id: number,
): CanonicalArtifactRow[] {
  return database
    .prepare(
      "SELECT submission_artifact_id, submission_id, architecture, " +
        "source_filename, staging_key, sha256, size_bytes, media_type, " +
        "validation_state, metadata_json, colophon_json " +
        "FROM submission_artifacts WHERE submission_id = ? " +
        "ORDER BY architecture",
    )
    .all(id) as CanonicalArtifactRow[];
}

/** Converts persisted metadata into the guarded workflow object shape. */
export function safeSubmissionMetadata(value: unknown): Record<string, unknown> {
  return object(value, "submission metadata is malformed");
}

/** Converts a persisted submission row into the stable review service record. */
export function toSubmissionRecord(
  database: Database.Database,
  row: CanonicalSubmissionRow,
): SubmissionRecord {
  const artifacts = loadCanonicalArtifacts(database, row.submission_id);
  const metadataRow = artifacts[0]?.metadata_json;
  const metadata = metadataRow
    ? safeSubmissionMetadata(parseJson(metadataRow, "submission metadata"))
    : {};

  return {
    id: row.submission_id,
    game_id: row.cartridge_id,
    version: row.version,
    status: submissionStatus(row.status),
    submitted_by_user_id: row.submitted_by_user_id,
    submitted_by: row.submitted_by,
    reviewed_by_user_id: row.reviewed_by_user_id,
    reviewed_by: row.reviewed_by,
    pending_dir: `storage/staging/submissions/${row.submission_id}`,
    metadata_json: json(metadata),
    architectures_json: json(
      artifacts.map((item) => ({
        architecture: item.architecture,
        file: item.source_filename,
        stored: item.staging_key,
        sha256: item.sha256,
        size_bytes: item.size_bytes,
        validation_state: item.validation_state,
      })),
    ),
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    metadata,
    architectures: artifacts.map((item) => ({
      architecture: item.architecture,
      file: item.source_filename,
      stored: item.staging_key,
      sha256: item.sha256,
      size_bytes: item.size_bytes,
      validation_state: item.validation_state,
    })),
    revision_of_submission_id: row.revision_of_submission_id,
    revision_number: row.revision_number,
    review_history: database
      .prepare(
        "SELECT decision_id, decision, reviewer_name, metadata_json, " +
          "note, created_at FROM review_decisions " +
          "WHERE submission_id = ? ORDER BY created_at ASC, decision_id ASC",
      )
      .all(row.submission_id) as Array<Record<string, unknown>>,
  };
}
