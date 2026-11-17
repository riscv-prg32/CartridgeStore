import type Database from "better-sqlite3";

import type { ReviewErrorCode } from "../review/errors.js";
import type { CanonicalObjectPlan } from "./workflow-objects.js";
import { json } from "./workflow-codecs.js";

/** Journal manifest fields required to commit canonical publication visibility. */
export interface CanonicalWorkflowManifest {
  readonly journalVersion: 1;
  readonly operationId: string;
  readonly releaseId: string;
  readonly submissionId: number;
  readonly cartridgeId: string;
  readonly version: string;
  readonly reviewUpdates: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly colophon: Record<string, unknown> | null;
  readonly reviewer: { readonly id: number; readonly name: string };
  readonly objects: readonly CanonicalObjectPlan[];
}

interface VisibilityOptions {
  readonly database: Database.Database;
  readonly manifest: CanonicalWorkflowManifest;
  readonly operationId: string;
  readonly now: () => string;
  readonly fail: (
    message: string,
    code?: ReviewErrorCode,
    status?: number,
  ) => never;
  readonly beforeVisibility: () => void;
  readonly afterVisibility: () => void;
}

/** Commits release, artifact and media visibility for a prepared operation. */
export function commitCanonicalVisibility(options: VisibilityOptions): void {
  const {
    afterVisibility,
    beforeVisibility,
    database,
    fail,
    manifest,
    now,
    operationId,
  } = options;

  beforeVisibility();
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database
      .prepare(
        "SELECT release_id, state FROM releases " +
          "WHERE cartridge_id = ? AND version = ? AND state = 'published'",
      )
      .get(manifest.cartridgeId, manifest.version) as
      | { release_id?: string; state?: string }
      | undefined;
    let releaseId = manifest.releaseId;
    if (existing && existing.release_id !== releaseId) {
      fail("published version already exists", "review_state_conflict");
    }

    if (!existing) {
      const order =
        Number(
          (
            database
              .prepare(
                "SELECT COALESCE(MAX(published_order), 0) AS value " +
                  "FROM releases",
              )
              .get() as { value: number }
          ).value,
        ) + 1;
      const title =
        typeof manifest.metadata.title === "string"
          ? manifest.metadata.title
          : manifest.cartridgeId;
      const summary =
        typeof manifest.metadata.summary === "string"
          ? manifest.metadata.summary
          : "";
      database
        .prepare(
          "INSERT INTO releases(" +
            "release_id, cartridge_id, version, revision, state, title, " +
            "summary, authors_json, tags_json, metadata_json, colophon_json, " +
            "created_at, submitted_at, published_at, published_order, " +
            "created_by_user_id, reviewer_user_id" +
            ") VALUES (?, ?, ?, 1, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          releaseId,
          manifest.cartridgeId,
          manifest.version,
          title,
          summary,
          json(manifest.metadata.authors ?? []),
          json(manifest.metadata.tags ?? []),
          json(manifest.metadata),
          manifest.colophon ? json(manifest.colophon) : null,
          now(),
          now(),
          now(),
          order,
          null,
          manifest.reviewer.id,
        );

      for (const artifact of manifest.objects.filter(
        (item) => item.objectKind === "artifact",
      )) {
        const compatibility = {
          legacyPublicVariant: {
            architecture: artifact.architecture,
            size: artifact.sizeBytes,
            sha256: artifact.sha256,
            has_screenshot: manifest.objects.some(
              (item) =>
                item.objectKind === "media" &&
                item.targetRole === "screenshot" &&
                item.architecture === artifact.architecture,
            ),
            has_signature: false,
          },
        };
        database
          .prepare(
            "INSERT INTO artifacts(" +
              "artifact_id, release_id, architecture, object_id, " +
              "compatibility_json, state, created_at" +
              ") VALUES (?, ?, ?, ?, ?, 'published', ?)",
          )
          .run(
            artifact.artifactId,
            releaseId,
            artifact.architecture,
            artifact.objectId,
            json(compatibility),
            now(),
          );
      }

      for (const media of manifest.objects.filter(
        (item) => item.objectKind === "media",
      )) {
        database
          .prepare(
            "INSERT INTO media(" +
              "media_id, release_id, architecture, kind, object_id, created_at" +
              ") VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            media.mediaId,
            releaseId,
            media.architecture,
            media.targetRole,
            media.objectId,
            now(),
          );
      }
    } else {
      releaseId = String(existing.release_id);
    }

    database
      .prepare(
        "UPDATE submission_artifacts SET validation_state = 'promoted' " +
          "WHERE submission_id = ?",
      )
      .run(manifest.submissionId);
    database
      .prepare(
        "UPDATE submissions SET status = 'published', " +
          "reviewed_by_user_id = ?, reviewed_by = ?, " +
          "reviewed_at = COALESCE(reviewed_at, ?), published_release_id = ? " +
          "WHERE submission_id = ? AND status IN ('pending_review', 'approved')",
      )
      .run(
        manifest.reviewer.id,
        manifest.reviewer.name,
        now(),
        releaseId,
        manifest.submissionId,
      );
    database
      .prepare(
        "UPDATE publication_operations SET release_id = ?, " +
          "state = 'database_committed', committed_at = COALESCE(committed_at, ?), " +
          "updated_at = ? WHERE operation_id = ? AND state IN " +
          "('objects_verified', 'objects_staged', 'prepared')",
      )
      .run(releaseId, now(), now(), operationId);
    database
      .prepare(
        "INSERT INTO publication_events(" +
          "operation_id, from_state, to_state, event_code, details_json, created_at" +
          ") VALUES (?, 'objects_verified', 'database_committed', " +
          "'canonical_visibility_committed', '{}', ?)",
      )
      .run(operationId, now());
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
  afterVisibility();
}
