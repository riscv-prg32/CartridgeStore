import type Database from "better-sqlite3";

export const LEGACY_SNAPSHOT_ABI = "prg32-legacy-snapshot-1.0";
export const LEGACY_MANIFEST_ABI = "prg32-storage-migration-manifest-1.0";
export const LEGACY_MANIFEST_VERSION = 1;
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
export const MAX_MARKER_BYTES = 64 * 1024;
export const MAX_JSON_DEPTH = 16;
export const MAX_JSON_NODES = 100_000;
export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
export const MAX_CARTRIDGE_BYTES = 128 * 1024 * 1024;
export const MAX_DIAGNOSTICS = 2_000;

export type LegacyAnomalySeverity = "INFO" | "WARNING" | "BLOCKER";

export interface LegacySnapshotConfig {
  readonly root: string;
  readonly databasePath: string;
  readonly catalogPath: string;
  readonly dataRoot: string;
  readonly cartridgeRoot: string;
  readonly preparedMarkerPath: string;
  readonly submissionRoot?: string | null;
  readonly mediaRoot?: string | null;
}

export interface ResolvedLegacySnapshotPaths {
  readonly root: string;
  readonly databasePath: string;
  readonly catalogPath: string;
  readonly dataRoot: string;
  readonly cartridgeRoot: string;
  readonly preparedMarkerPath: string;
  readonly submissionRoot: string | null;
  readonly mediaRoot: string | null;
}

export interface LegacyAnomaly {
  readonly code: string;
  readonly severity: LegacyAnomalySeverity;
  readonly entity: string;
  readonly description: string;
  readonly migrationImpact: string;
}

export interface LegacyDatabaseInspection {
  readonly schemaFingerprint: string;
  readonly databaseFingerprint: string;
  readonly tables: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly foreignKeyViolations: readonly Record<string, unknown>[];
  readonly walPresent: boolean;
  readonly shmPresent: boolean;
}

export interface LegacySourceFile {
  readonly sourceRef: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly kind: "artifact" | "submission" | "site_asset" | "unknown";
}

export interface LegacyMediaEntry {
  readonly legacyId: string;
  readonly artifactLegacyId: string;
  readonly cartridgeId: string;
  readonly version: string;
  readonly architecture: string;
  readonly kind: "icon" | "screenshot";
  readonly sourceRef: string;
  readonly mediaType: string | null;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mappingStatus: "mapped" | "unsupported";
}

export interface LegacyArtifactEntry {
  readonly legacyId: string;
  readonly cartridgeId: string;
  readonly version: string;
  readonly architecture: string;
  readonly sourceRef: string;
  readonly exists: boolean;
  readonly regularFile: boolean;
  readonly symlinkSafe: boolean;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly expectedSizeBytes: number | null;
  readonly expectedSha256: string | null;
  readonly hashMatches: boolean | null;
  readonly sizeMatches: boolean | null;
  readonly mappingStatus: "mapped" | "blocked" | "unsupported";
  readonly metadata: Record<string, unknown> | null;
  readonly colophon: Record<string, unknown> | null;
  readonly media: readonly LegacyMediaEntry[];
  /** The public legacy variant fields retained for API differential checks. */
  readonly publicVariant: Readonly<Record<string, unknown>>;
  readonly compatibility: Readonly<Record<string, unknown>>;
}

export interface LegacyCartridgeEntry {
  readonly cartridgeId: string;
  readonly title: string;
  readonly summary: string;
  readonly authors: readonly unknown[];
  readonly tags: readonly unknown[];
  readonly latestVersion: string | null;
  readonly versions: readonly string[];
  readonly compatibility: Readonly<Record<string, unknown>>;
}

export interface LegacyReleaseEntry {
  readonly legacyId: string;
  readonly cartridgeId: string;
  readonly version: string;
  readonly publishedAt: string | null;
  readonly updatedAt: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly colophon: Record<string, unknown> | null;
  readonly architectures: readonly string[];
  readonly mappingStatus: "mapped" | "blocked";
  readonly compatibility: Readonly<Record<string, unknown>>;
}

export interface LegacySubmissionArtifactEntry {
  readonly architecture: string;
  readonly sourceRef: string;
  readonly exists: boolean;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly mappingStatus: "mapped" | "blocked" | "unsupported";
}

export interface LegacySubmissionEntry {
  readonly submissionId: number;
  readonly cartridgeId: string;
  readonly version: string;
  readonly sourceStatus: string;
  readonly targetStatus: string | null;
  readonly submittedByUserId: number | null;
  readonly reviewedByUserId: number | null;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
  readonly stagingDirectory: string | null;
  readonly artifacts: readonly LegacySubmissionArtifactEntry[];
  readonly metadata: Record<string, unknown> | null;
  readonly mappingStatus: "mapped" | "blocked";
}

export interface LegacyTelemetryEvent {
  readonly eventId: number;
  readonly cartridgeId: string;
  readonly version: string;
  readonly architecture: string;
  readonly userId: number | null;
  readonly downloadedAt: string;
  readonly artifactLegacyId: string | null;
  readonly mappingStatus: "mapped" | "unmapped" | "ambiguous";
}

export interface LegacyTelemetryInventory {
  readonly eventCount: number;
  readonly mappedCount: number;
  readonly unmappedCount: number;
  readonly ambiguousCount: number;
  readonly events: readonly LegacyTelemetryEvent[];
}

export interface LegacyReadiness {
  readonly inventoryComplete: boolean;
  readonly migrationReady: boolean;
  readonly operationalCutoverReady: false;
  readonly blockingAnomalyCount: number;
  readonly warningCount: number;
  readonly rationale: readonly string[];
}

export interface LegacyManifestSource {
  readonly snapshotAbi: string;
  readonly schemaFingerprint: string;
  readonly databaseFingerprint: string;
  readonly catalogFingerprint: string;
  readonly storageInventoryFingerprint: string;
  readonly databaseWalPresent: boolean;
  readonly databaseShmPresent: boolean;
  readonly paths: Readonly<Record<string, string | null>>;
}

export interface LegacyManifestSummary {
  readonly cartridges: number;
  readonly releases: number;
  readonly artifacts: number;
  readonly media: number;
  readonly submissions: number;
  readonly downloadEvents: number;
  readonly sourceFiles: number;
  readonly unreferencedFiles: number;
}

export interface LegacyManifest {
  readonly manifestAbi: string;
  readonly manifestVersion: number;
  readonly source: LegacyManifestSource;
  readonly target: Readonly<Record<string, number>>;
  readonly summary: LegacyManifestSummary;
  readonly database: LegacyDatabaseInspection;
  readonly cartridges: readonly LegacyCartridgeEntry[];
  readonly releases: readonly LegacyReleaseEntry[];
  readonly artifacts: readonly LegacyArtifactEntry[];
  readonly media: readonly LegacyMediaEntry[];
  readonly submissions: readonly LegacySubmissionEntry[];
  readonly telemetry: LegacyTelemetryInventory;
  readonly sourceFiles: readonly LegacySourceFile[];
  readonly unreferencedFiles: readonly LegacySourceFile[];
  readonly anomalies: readonly LegacyAnomaly[];
  readonly readiness: LegacyReadiness;
  readonly manifestSha256: string;
}

export interface LegacyInventoryResult {
  readonly manifest: LegacyManifest;
  readonly canonicalManifest: string;
  readonly humanReport: string;
}

export interface LegacyVerificationResult {
  readonly ok: boolean;
  readonly manifestSha256Matches: boolean;
  readonly sourceFingerprintsMatch: boolean;
  readonly recordCountsMatch: boolean;
  readonly artifactFilesMatch: boolean;
  readonly storageFilesMatch: boolean;
  readonly anomalies: readonly LegacyAnomaly[];
}

export interface OpenLegacySnapshot {
  readonly paths: ResolvedLegacySnapshotPaths;
  readonly sqlite: Database.Database;
  readonly marker: Readonly<Record<string, unknown>>;
  readonly database: LegacyDatabaseInspection;
  close(): void;
}
