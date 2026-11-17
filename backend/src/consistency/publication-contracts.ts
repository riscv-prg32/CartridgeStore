import type Database from "better-sqlite3";

/** States recorded by the publication journal. */
export const PUBLICATION_STATES = [
  "PREPARED",
  "STAGED",
  "VERIFIED",
  "FILES_REPLACED",
  "INDEX_REPLACED",
  "DATABASE_UPDATED",
  "COMPLETED",
  "COMPENSATING",
  "COMPENSATED",
  "RECOVERY_REQUIRED",
  "FAILED",
] as const;

/** A publication journal state. */
export type PublicationState = typeof PUBLICATION_STATES[number];

/** Fault injection points used by consistency tests and recovery drills. */
export type FaultPoint =
  | "after-operation-record"
  | "after-pending-validation"
  | "after-staging"
  | "after-staged-verification"
  | "before-binary-replacement"
  | "after-binary-replacement"
  | "before-index-temp-write"
  | "after-index-temp-write"
  | "before-index-replacement"
  | "after-index-replacement"
  | "before-database-update"
  | "after-database-update"
  | "before-completion"
  | "after-completion"
  | "before-compensation"
  | "after-compensation";

/** Filesystem and metadata details for one published architecture. */
export interface PublicationVariantPlan {
  readonly architecture: string;
  readonly sourceRelative: string;
  readonly targetRelative: string;
  readonly stagedRelative: string;
  readonly backupRelative: string;
  readonly expectedSha256: string;
  readonly previousSha256: string | null;
  readonly size: number;
  readonly metadata: Record<string, unknown>;
  readonly colophon: Record<string, unknown> | null;
  readonly iconMime: string | null;
  readonly screenshotMime: string | null;
  readonly hasScreenshot: boolean;
  readonly hasSignature: boolean;
}

/** The publication flow that produced a journal operation. */
export type PublicationOperationKind = "submission" | "catalog";

/** The catalog mutation represented by a catalog operation. */
export type CatalogMutationAction = "update" | "delete";

/** Durable operation record written to the publication journal. */
export interface PublicationOperation {
  readonly journalVersion: 1;
  readonly operationKind?: PublicationOperationKind;
  readonly catalogAction?: CatalogMutationAction;
  readonly operationId: string;
  readonly submissionId: number;
  readonly gameId: string;
  readonly version: string;
  readonly variants: readonly PublicationVariantPlan[];
  readonly previousIndexSha256: string | null;
  readonly expectedIndexSha256: string;
  readonly indexStagedRelative: string;
  readonly indexBackupRelative: string;
  readonly state: PublicationState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedMetadata?: Record<string, unknown>;
  readonly reviewer?: { readonly id: number; readonly name: string };
  readonly error?: { readonly code: string; readonly message: string };
}

/** Optional review metadata attached while preparing a submission. */
export interface PublicationReviewOptions {
  readonly metadata?: Record<string, unknown>;
  readonly reviewer?: { readonly id: number; readonly name: string };
}

/** Input for updating or deleting an existing catalog version. */
export interface CatalogMutationOptions {
  readonly gameId: string;
  readonly version: string;
  readonly metadata?: Record<string, unknown>;
  readonly architecture?: string;
}

/** Metadata fields that reviewers may change. */
export const REVIEW_EDITABLE_METADATA_FIELDS = [
  "title",
  "summary",
  "description",
  "tags",
  "license",
  "homepage",
  "repository",
] as const;

/** Reconciliation severity for publication storage findings. */
export type ReconciliationClassification =
  | "CONSISTENT"
  | "RECOVERABLE"
  | "AMBIGUOUS"
  | "CORRUPT";

/** One actionable finding from publication reconciliation. */
export interface ReconciliationFinding {
  readonly code: string;
  readonly classification: Exclude<ReconciliationClassification, "CONSISTENT">;
  readonly message: string;
  readonly path?: string;
  readonly operationId?: string;
  readonly submissionId?: number;
  readonly details?: Record<string, unknown>;
}

/** Full result returned by publication reconciliation. */
export interface ReconciliationReport {
  readonly status: ReconciliationClassification;
  readonly checkedAt: string;
  readonly root: string;
  readonly findings: readonly ReconciliationFinding[];
  readonly counts: Record<string, number>;
}

/** Dependencies required by the publication consistency service. */
export interface PublicationConsistencyOptions {
  readonly root: string;
  readonly database: Database.Database;
  readonly fault?: (point: FaultPoint) => void;
}
