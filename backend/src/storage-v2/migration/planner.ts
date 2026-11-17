import crypto from "node:crypto";

import { TARGET_SCHEMA_VERSION, TARGET_STORAGE_LAYOUT_VERSION } from "../types.js";
import type { LegacyManifest } from "../legacy/types.js";
import type { MigrationPlan } from "./types.js";

function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
export function stableId(prefix: string, value: string): string {
  return `${prefix}_${digest(value).slice(0, 32)}`;
}

export function migrationId(manifest: LegacyManifest): string {
  return `migration_${manifest.manifestSha256.slice(0, 32)}`;
}

export function cartridgeId(value: string): string {
  return value;
}

export function releaseId(legacyId: string): string {
  return stableId("release", legacyId);
}

export function artifactId(legacyId: string): string {
  return stableId("artifact", legacyId);
}

export function mediaId(legacyId: string): string {
  return stableId("media", legacyId);
}

export function submissionArtifactId(submissionId: number, architecture: string): string {
  return stableId("submission-artifact", `${submissionId}:${architecture}`);
}

export function decisionId(submissionId: number): string {
  return stableId("decision", String(submissionId));
}

export function objectId(kind: string, legacyId: string, sha256: string): string {
  return `obj_${digest(`${kind}\0${legacyId}\0${sha256}`).slice(0, 32)}`;
}

export function exceptionId(migration: string, kind: string, legacyId: string): string {
  return stableId("exception", `${migration}:${kind}:${legacyId}`);
}

export function siteAssetKey(sourceRef: string): string {
  const value = sourceRef.replaceAll("/", "_").replace(/[^A-Za-z0-9._-]/gu, "_");
  return value.slice(0, 128) || "legacy_asset";
}

export function planMigration(manifest: LegacyManifest): MigrationPlan {
  return {
    migrationId: migrationId(manifest),
    manifestSha256: manifest.manifestSha256,
    targetSchemaVersion: TARGET_SCHEMA_VERSION,
    targetStorageLayoutVersion: TARGET_STORAGE_LAYOUT_VERSION,
    tables: ["users", "groups", "user_groups", "api_tokens", "registration_tokens", "store_settings", "scores", "runs", "samples"],
    cartridges: manifest.cartridges.map((item) => item.cartridgeId),
    releases: manifest.releases.map((item) => item.legacyId),
    artifacts: manifest.artifacts.map((item) => item.legacyId),
    media: manifest.media.map((item) => item.legacyId),
    submissions: manifest.submissions.map((item) => item.submissionId),
    telemetry: manifest.telemetry.events.map((item) => item.eventId),
    siteAssets: manifest.sourceFiles.filter((item) => item.kind === "site_asset").map((item) => item.sourceRef),
    exceptionCount: manifest.telemetry.unmappedCount + manifest.telemetry.ambiguousCount
  };
}
