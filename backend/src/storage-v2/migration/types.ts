import type { LegacyManifest, LegacySnapshotConfig } from "../legacy/types.js";

export const DISPOSABLE_MIGRATION_AUTHORIZATION = "M5.2c-DISPOSABLE-TARGET";
export const MIGRATION_ABI = "prg32-storage-v2-migration-1.0";
export const MAX_MIGRATION_DIAGNOSTICS = 2_000;

export interface MigrationConfig {
  readonly snapshot: LegacySnapshotConfig;
  readonly manifestPath?: string;
  readonly manifest?: LegacyManifest;
  readonly targetRoot: string;
  readonly authorization: string;
  readonly faultAt?: MigrationFaultPoint;
}
export type MigrationFaultPoint =
  | "after-initialize"
  | "after-compatible-table"
  | "after-artifact"
  | "after-media"
  | "after-submission"
  | "after-telemetry"
  | "before-finalization"
  | "after-finalization"
  | "before-verification";

export type MigrationPhase =
  | "initialized"
  | "compatible-data"
  | "artifacts"
  | "media"
  | "submissions"
  | "telemetry"
  | "finalization"
  | "verifying"
  | "completed"
  | "failed"
  | "recovery_required";

export interface MigrationJournal {
  readonly abi: string;
  readonly migrationId: string;
  readonly manifestSha256: string;
  readonly sourceDatabaseFingerprint: string;
  readonly sourceStorageFingerprint: string;
  readonly targetSchemaVersion: number;
  readonly targetStorageLayoutVersion: number;
  readonly phase: MigrationPhase;
  readonly completedTables: readonly string[];
  readonly completedArtifacts: readonly string[];
  readonly completedMedia: readonly string[];
  readonly completedSubmissions: readonly number[];
  readonly completedTelemetry: readonly number[];
  readonly checkpoints: readonly string[];
  readonly errors: readonly MigrationJournalError[];
  readonly recoveryState: "none" | "resume_available" | "verification_required" | "conflict";
  readonly completionState: "incomplete" | "completed";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MigrationJournalError {
  readonly code: string;
  readonly phase: MigrationPhase;
  readonly message: string;
  readonly at: string;
}

export interface MigrationPlan {
  readonly migrationId: string;
  readonly manifestSha256: string;
  readonly targetSchemaVersion: number;
  readonly targetStorageLayoutVersion: number;
  readonly tables: readonly string[];
  readonly cartridges: readonly string[];
  readonly releases: readonly string[];
  readonly artifacts: readonly string[];
  readonly media: readonly string[];
  readonly submissions: readonly number[];
  readonly telemetry: readonly number[];
  readonly siteAssets: readonly string[];
  readonly exceptionCount: number;
}

export interface MigrationVerificationResult {
  readonly ok: boolean;
  readonly migrationId: string;
  readonly targetAuditOk: boolean;
  readonly differentialOk: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly mismatches: readonly string[];
  readonly exceptionCount: number;
}

export interface MigrationResult {
  readonly ok: boolean;
  readonly alreadyCompleted: boolean;
  readonly migrationId: string;
  readonly phase: MigrationPhase;
  readonly targetRoot: string;
  readonly plan: MigrationPlan;
  readonly journal: MigrationJournal;
  readonly verification: MigrationVerificationResult | null;
}
