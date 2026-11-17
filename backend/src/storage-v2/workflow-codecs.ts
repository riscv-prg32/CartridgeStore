import crypto from "node:crypto";

import { applyReviewMetadata } from "../consistency/publication.js";
import { ReviewError } from "../review/errors.js";

/** Serializes workflow values for SQLite and journal payloads. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Creates a namespaced identifier for a workflow record. */
export function uuid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** Calculates the SHA-256 digest used by workflow object plans. */
export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Detects the media type supported by the canonical workflow. */
export function mediaType(bytes: Uint8Array): string {
  if (
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from("89504e470d0a1a0a", "hex"),
    )
  ) {
    return "image/png";
  }

  if (
    Buffer.from(bytes.subarray(0, 3)).equals(
      Buffer.from([0xff, 0xd8, 0xff]),
    )
  ) {
    return "image/jpeg";
  }

  return "application/octet-stream";
}

/** Validates that a parsed JSON value is an object. */
export function object(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new ReviewError(message, "review_operation_failed", 500);
  }

  return value as Record<string, unknown>;
}

/** Parses a persisted JSON value and translates corruption to a review error. */
export function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ReviewError(
      `${label} is malformed`,
      "review_operation_failed",
      500,
    );
  }
}

/** Maps persisted submission states to the public review state vocabulary. */
export function submissionStatus(value: string): string {
  if (value === "pending_review" || value === "validated") {
    return "pending";
  }

  if (value === "published" || value === "approved") {
    return "verified";
  }

  return value;
}

/** Removes workflow-only fields from metadata before publication. */
export function publicationMetadata(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  delete copy.assets;
  delete copy.architectures;
  delete copy.colophon;
  copy.summary ??= "";
  return copy;
}

/** Applies reviewer metadata updates while preserving review error semantics. */
export function reviewedMetadata(
  original: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return applyReviewMetadata(original, updates);
  } catch (error) {
    throw new ReviewError(
      error instanceof Error ? error.message : "review metadata is invalid",
      "review_invalid_request",
      400,
      { cause: error },
    );
  }
}
