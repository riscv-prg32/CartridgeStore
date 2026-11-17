import crypto from "node:crypto";

import {
  buildSubmissionCartridge,
  normalizeArchitecture,
  validateCartridgeBinary,
  validateMetadata,
  type parseCartridge,
} from "../submission/prg32.js";
import { PublicationConsistencyError } from "./errors.js";
import {
  PUBLICATION_STATES,
  REVIEW_EDITABLE_METADATA_FIELDS,
  type PublicationOperation,
  type PublicationVariantPlan,
  type ReconciliationClassification,
  type ReconciliationFinding,
} from "./publication-contracts.js";

/** Raises a typed publication consistency failure. */
export function fail(
  message: string,
  code = "publication_consistency_failed",
  details?: unknown,
): never {
  throw new PublicationConsistencyError(message, code, details);
}

/** Narrows an unknown JSON value to a record or raises a journal error. */
export function object(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(message, "journal_corrupt");
  }
  return value as Record<string, unknown>;
}

/** Clones JSON-compatible values without changing their serialized shape. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Applies review-editable metadata while preserving immutable identity fields. */
export function applyReviewMetadata(
  original: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const forbidden = ["id", "version", "authors"] as const;
  for (const field of forbidden) {
    if (
      Object.hasOwn(updates, field) &&
      JSON.stringify(updates[field]) !== JSON.stringify(original[field])
    ) {
      fail(
        `metadata.${field} cannot be changed during review`,
        "review_metadata_invalid",
      );
    }
  }
  const metadata = clone(original);
  for (const field of REVIEW_EDITABLE_METADATA_FIELDS) {
    if (Object.hasOwn(updates, field)) metadata[field] = updates[field];
  }
  metadata.id = original.id;
  metadata.version = original.version;
  metadata.authors = original.authors ?? [];
  try {
    validateMetadata(metadata);
  } catch (error) {
    fail(
      error instanceof Error ? error.message : "review metadata is invalid",
      "review_metadata_invalid",
    );
  }
  return metadata;
}

/** Rebuilds a cartridge when review metadata changes, preserving its payload. */
export function reviewedImage(
  source: Uint8Array,
  architecture: string,
  metadata: Record<string, unknown> | undefined,
  colophonOverride?: Record<string, unknown> | null,
): {
  readonly image: Buffer;
  readonly parsed: ReturnType<typeof parseCartridge>;
} {
  const original = validateCartridgeBinary(source);
  if (!metadata) return { image: Buffer.from(source), parsed: original };
  if (!original.metadata || !original.icon) {
    fail(
      "pending cartridge metadata or icon is missing",
      "pending_cartridge_invalid",
    );
  }
  let normalizedArchitecture: "esp32c6" | "qemu";
  try {
    normalizedArchitecture = normalizeArchitecture(architecture);
  } catch (error) {
    fail(
      error instanceof Error ? error.message : "unsupported architecture",
      "pending_cartridge_invalid",
    );
  }
  const variantMetadata = applyReviewMetadata(original.metadata, metadata);
  const rebuilt = buildSubmissionCartridge(
    original.legacyPayload,
    variantMetadata,
    original.icon,
    normalizedArchitecture,
    original.screenshot,
    colophonOverride === undefined ? original.colophon : colophonOverride,
  );
  return {
    image: Buffer.from(rebuilt),
    parsed: validateCartridgeBinary(rebuilt),
  };
}

/** Updates catalog colophon identity fields after a metadata edit. */
export function catalogColophon(
  original: Record<string, unknown> | null,
  metadata: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!original) return null;
  const next = clone(original);
  next.title = metadata.title;
  next.version = metadata.version;
  return next;
}

/** Returns an ISO timestamp for journal records and catalog indexes. */
export function isoNow(): string {
  return new Date().toISOString();
}

/** Computes the SHA-256 identity used by publication journal records. */
export function sha256(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortedJson(item)]),
    );
  }
  return value;
}

/** Serializes publication JSON with the canonical stable key ordering. */
export function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(sortedJson(value), null, 2)}\n`, "utf8");
}

/** Parses a required JSON object from a database or journal field. */
export function parseObjectJson(
  value: string,
  label: string,
): Record<string, unknown> {
  try {
    return object(JSON.parse(value) as unknown, label);
  } catch (error) {
    if (error instanceof PublicationConsistencyError) throw error;
    fail(`${label} is malformed`, "submission_metadata_corrupt");
  }
}

/** Parses the stored architecture list from a submission row. */
export function parseArchitectures(value: string): Array<{
  readonly architecture?: unknown;
  readonly stored?: unknown;
  readonly file?: unknown;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("submission architectures are malformed", "submission_metadata_corrupt");
  }
  if (!Array.isArray(parsed)) {
    fail("submission architectures are not an array", "submission_metadata_corrupt");
  }
  return parsed.map(
    (item) =>
      object(item, "submission architecture is malformed") as {
        readonly architecture?: unknown;
        readonly stored?: unknown;
        readonly file?: unknown;
      },
  );
}

/** Identifies the supported image formats embedded in a cartridge. */
export function imageMime(data: Uint8Array | null): string | null {
  if (!data) return null;
  if (
    Buffer.from(data.subarray(0, 8)).equals(
      Buffer.from("89504e470d0a1a0a", "hex"),
    )
  ) {
    return "image/png";
  }
  if (
    Buffer.from(data.subarray(0, 3)).equals(
      Buffer.from([0xff, 0xd8, 0xff]),
    )
  ) {
    return "image/jpeg";
  }
  return null;
}

/** Validates and normalizes a journal operation read from disk. */
export function parseOperation(value: unknown): PublicationOperation {
  const raw = object(value, "publication operation is malformed");
  if (
    raw.journalVersion !== 1 ||
    typeof raw.operationId !== "string" ||
    typeof raw.submissionId !== "number" ||
    typeof raw.gameId !== "string" ||
    typeof raw.version !== "string" ||
    typeof raw.expectedIndexSha256 !== "string" ||
    typeof raw.indexStagedRelative !== "string" ||
    typeof raw.indexBackupRelative !== "string" ||
    typeof raw.createdAt !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !PUBLICATION_STATES.includes(raw.state as PublicationOperation["state"]) ||
    !Array.isArray(raw.variants)
  ) {
    fail("publication operation is malformed", "journal_corrupt");
  }
  const variants = raw.variants.map((item) => {
    const variant = object(item, "publication variant is malformed");
    if (
      typeof variant.architecture !== "string" ||
      typeof variant.sourceRelative !== "string" ||
      typeof variant.targetRelative !== "string" ||
      typeof variant.stagedRelative !== "string" ||
      typeof variant.backupRelative !== "string" ||
      typeof variant.expectedSha256 !== "string" ||
      (variant.previousSha256 !== null &&
        typeof variant.previousSha256 !== "string") ||
      typeof variant.size !== "number" ||
      variant.metadata === null ||
      typeof variant.metadata !== "object" ||
      Array.isArray(variant.metadata) ||
      (variant.colophon !== null &&
        (typeof variant.colophon !== "object" ||
          Array.isArray(variant.colophon)))
    ) {
      fail("publication variant is malformed", "journal_corrupt");
    }
    return variant as unknown as PublicationVariantPlan;
  });
  if (
    raw.reviewedMetadata !== undefined &&
    (raw.reviewedMetadata === null ||
      typeof raw.reviewedMetadata !== "object" ||
      Array.isArray(raw.reviewedMetadata))
  ) {
    fail("publication reviewed metadata is malformed", "journal_corrupt");
  }
  if (raw.reviewer !== undefined) {
    const reviewer = object(raw.reviewer, "publication reviewer is malformed");
    if (
      !Number.isSafeInteger(reviewer.id) ||
      (reviewer.id as number) <= 0 ||
      typeof reviewer.name !== "string" ||
      !reviewer.name
    ) {
      fail("publication reviewer is malformed", "journal_corrupt");
    }
  }
  const operationKind = raw.operationKind ?? "submission";
  if (operationKind !== "submission" && operationKind !== "catalog") {
    fail("publication operation kind is malformed", "journal_corrupt");
  }
  if (
    operationKind === "catalog" &&
    raw.catalogAction !== "update" &&
    raw.catalogAction !== "delete"
  ) {
    fail("catalog operation action is malformed", "journal_corrupt");
  }
  return { ...raw, variants } as unknown as PublicationOperation;
}

/** Derives the aggregate reconciliation status from individual findings. */
export function statusForFindings(
  findings: readonly ReconciliationFinding[],
): ReconciliationClassification {
  if (findings.length === 0) return "CONSISTENT";
  if (findings.some((finding) => finding.classification === "CORRUPT")) {
    return "CORRUPT";
  }
  if (findings.some((finding) => finding.classification === "AMBIGUOUS")) {
    return "AMBIGUOUS";
  }
  return "RECOVERABLE";
}
