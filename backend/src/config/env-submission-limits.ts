import { positiveInteger } from "./env-values.js";

/** Resolved submission archive and review limits. */
export interface SubmissionLimitsEnvironmentConfig {
  readonly submissionMaxArchiveBytes: number;
  readonly submissionMaxEntries: number;
  readonly submissionMaxEntryUncompressedBytes: number;
  readonly submissionMaxTotalUncompressedBytes: number;
  readonly submissionMaxCompressionRatio: number;
  readonly submissionMaxManifestBytes: number;
  readonly reviewMaxSubmissions: number;
}

/** Parses submission archive and review limits. */
export function resolveSubmissionLimitsConfig(
  environment: NodeJS.ProcessEnv,
): SubmissionLimitsEnvironmentConfig {
  const submissionMaxArchiveBytes = positiveInteger(
    "PRG32_BACKEND_SUBMISSION_MAX_ARCHIVE_BYTES",
    environment.PRG32_BACKEND_SUBMISSION_MAX_ARCHIVE_BYTES,
    64 * 1024 * 1024,
  );
  const submissionMaxEntries = positiveInteger(
    "PRG32_BACKEND_SUBMISSION_MAX_ENTRIES",
    environment.PRG32_BACKEND_SUBMISSION_MAX_ENTRIES,
    128,
  );
  const submissionMaxEntryUncompressedBytes = positiveInteger(
    "PRG32_BACKEND_SUBMISSION_MAX_ENTRY_BYTES",
    environment.PRG32_BACKEND_SUBMISSION_MAX_ENTRY_BYTES,
    32 * 1024 * 1024,
  );
  const submissionMaxTotalUncompressedBytes = positiveInteger(
    "PRG32_BACKEND_SUBMISSION_MAX_TOTAL_BYTES",
    environment.PRG32_BACKEND_SUBMISSION_MAX_TOTAL_BYTES,
    128 * 1024 * 1024,
  );
  const submissionMaxCompressionRatio =
    environment.PRG32_BACKEND_SUBMISSION_MAX_COMPRESSION_RATIO === undefined
      ? 100
      : Number(environment.PRG32_BACKEND_SUBMISSION_MAX_COMPRESSION_RATIO);
  if (
    !Number.isFinite(submissionMaxCompressionRatio) ||
    submissionMaxCompressionRatio <= 0
  ) {
    throw new Error(
      "PRG32_BACKEND_SUBMISSION_MAX_COMPRESSION_RATIO must be positive",
    );
  }
  const submissionMaxManifestBytes = positiveInteger(
    "PRG32_BACKEND_SUBMISSION_MAX_MANIFEST_BYTES",
    environment.PRG32_BACKEND_SUBMISSION_MAX_MANIFEST_BYTES,
    256 * 1024,
  );
  const reviewMaxSubmissions = positiveInteger(
    "PRG32_BACKEND_REVIEW_MAX_SUBMISSIONS",
    environment.PRG32_BACKEND_REVIEW_MAX_SUBMISSIONS,
    1000,
  );

  return {
    submissionMaxArchiveBytes,
    submissionMaxEntries,
    submissionMaxEntryUncompressedBytes,
    submissionMaxTotalUncompressedBytes,
    submissionMaxCompressionRatio,
    submissionMaxManifestBytes,
    reviewMaxSubmissions,
  };
}
