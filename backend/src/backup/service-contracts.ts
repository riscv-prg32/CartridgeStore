import type { SecretStore } from "../secrets/service.js";

/** Downloadable backup artifact produced by the export workflow. */
export interface BackupArtifact {
  readonly path: string;
  readonly encrypted: boolean;
  readonly filename: string;
}

/** Result returned after a backup restore completes. */
export interface RestoreResult {
  readonly operationId: string;
  readonly format: string;
  readonly state: "COMPLETED";
  readonly entries: number;
  readonly expandedBytes: number;
}

/** Fault injection points used by restore recovery tests. */
export type BackupFaultPoint =
  | "after-db-replacement"
  | "after-filesystem-replacement"
  | "before-verification";

/** Optional dependencies for the application backup service. */
export interface BackupServiceOptions {
  readonly fault?: (point: BackupFaultPoint) => void;
  readonly secrets?: SecretStore;
}
