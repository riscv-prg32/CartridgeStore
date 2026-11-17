/**
 * Canonical download telemetry persistence.
 */

import crypto from "node:crypto";

import type Database from "better-sqlite3";

import type { CanonicalDownloadEvent } from "./workflow-contracts.js";

/** Records one canonical artifact download in the durable telemetry table. */
export function recordCanonicalDownload(
  database: Database.Database,
  event: CanonicalDownloadEvent,
  now: () => string
): void {
  const target = database
    .prepare(
      `SELECT r.release_id, a.artifact_id
       FROM releases r
       JOIN artifacts a ON a.release_id = r.release_id
       JOIN storage_objects o ON o.object_id = a.object_id
      WHERE r.cartridge_id = ? AND r.version = ? AND r.state = 'published'
        AND a.architecture = ? AND a.state = 'published' AND o.state = 'available'
      LIMIT 1`
    )
    .get(event.gameId, event.version, event.architecture) as
    | { release_id?: string; artifact_id?: string }
    | undefined;
  if (!target?.release_id || !target.artifact_id) {
    throw new Error("canonical download target is unavailable");
  }
  const ipHash = crypto
    .createHash("sha256")
    .update(event.ipAddress ?? "", "utf8")
    .digest("hex");
  const userId =
    event.userId !== null &&
    Number.isSafeInteger(event.userId) &&
    event.userId > 0
      ? event.userId
      : null;
  const userAgent = event.userAgent.slice(0, 300);
  const downloadedAt = now();
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        `INSERT INTO download_events(
           cartridge_id, release_id, artifact_id, version, architecture,
           user_id, ip_hash, user_agent, downloaded_at, delivery_outcome
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'started')`
      )
      .run(
        event.gameId,
        target.release_id,
        target.artifact_id,
        event.version,
        event.architecture,
        userId,
        ipHash,
        userAgent,
        downloadedAt
      );
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw new Error("canonical download telemetry could not be recorded", {
      cause: error
    });
  }
}
