import fs from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  hashFile,
  readBounded,
  parseBoundedJson,
  relativeSourceRef,
  resolveLegacyReference,
  sha256Bytes,
  stableFileFingerprint,
  walkTree
} from "./filesystem.js";
import { openLegacySnapshot } from "./database.js";
import { MAX_CATALOG_BYTES, type LegacyAnomaly, type LegacyManifest, type LegacySnapshotConfig, type LegacySourceFile, type LegacyVerificationResult } from "./types.js";

function manifestPayload(manifest: LegacyManifest): Omit<LegacyManifest, "manifestSha256"> {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifestSha256")) as Omit<LegacyManifest, "manifestSha256">;
}

export function canonicalManifestJson(manifest: LegacyManifest | Omit<LegacyManifest, "manifestSha256">): string {
  const payload = "manifestSha256" in manifest ? manifestPayload(manifest) : manifest;
  return canonicalJson(payload);
}

export function manifestFingerprint(manifest: LegacyManifest | Omit<LegacyManifest, "manifestSha256">): string {
  return sha256Bytes(canonicalManifestJson(manifest));
}

function anomaly(code: string, entity: string, description: string): LegacyAnomaly {
  return { code, severity: "BLOCKER", entity, description, migrationImpact: "manifest verification cannot establish a safe migration input" };
}

function actualFiles(config: LegacySnapshotConfig): readonly LegacySourceFile[] {
  const root = path.resolve(config.root);
  const files: LegacySourceFile[] = [];
  const scopes: Array<{ root: string; kind: LegacySourceFile["kind"] }> = [
    { root: path.resolve(root, config.cartridgeRoot), kind: "artifact" }
  ];
  if (config.submissionRoot) scopes.push({ root: path.resolve(root, config.submissionRoot), kind: "submission" });
  if (config.mediaRoot) scopes.push({ root: path.resolve(root, config.mediaRoot), kind: "site_asset" });
  for (const scope of scopes) {
    if (!fs.existsSync(scope.root)) continue;
    for (const entry of walkTree(root, scope.root)) {
      if (entry.type !== "file") continue;
      const file = hashFile(entry);
      files.push({ sourceRef: file.sourceRef, sizeBytes: file.sizeBytes, sha256: file.sha256, kind: scope.kind });
    }
  }
  return [...new Map(files.map((file) => [file.sourceRef, file])).values()].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
}

function catalogCounts(config: LegacySnapshotConfig): { readonly cartridges: number; readonly releases: number; readonly artifacts: number } {
  const root = parseBoundedJson(path.resolve(config.root, config.catalogPath), MAX_CATALOG_BYTES, "legacy index.json") as Record<string, unknown>;
  const games = root.games !== null && typeof root.games === "object" && !Array.isArray(root.games) ? root.games as Record<string, unknown> : {};
  let releases = 0;
  let artifacts = 0;
  for (const value of Object.values(games)) {
    const game = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const versions = game.versions !== null && typeof game.versions === "object" && !Array.isArray(game.versions) ? game.versions as Record<string, unknown> : {};
    releases += Object.keys(versions).length;
    for (const version of Object.values(versions)) {
      const row = version !== null && typeof version === "object" && !Array.isArray(version) ? version as Record<string, unknown> : {};
      const architectures = row.architectures !== null && typeof row.architectures === "object" && !Array.isArray(row.architectures) ? row.architectures as Record<string, unknown> : {};
      artifacts += Object.keys(architectures).length;
    }
  }
  return { cartridges: Object.keys(games).length, releases, artifacts };
}

export function verifyLegacyManifest(config: LegacySnapshotConfig, manifest: LegacyManifest): LegacyVerificationResult {
  const anomalies: LegacyAnomaly[] = [];
  const manifestSha256Matches = manifestFingerprint(manifest) === manifest.manifestSha256;
  if (!manifestSha256Matches) anomalies.push(anomaly("manifest_hash_mismatch", "manifest", "manifest SHA-256 does not match its canonical payload"));
  let sourceFingerprintsMatch = true;
  let recordCountsMatch = true;
  let artifactFilesMatch = true;
  let storageFilesMatch = true;
  let snapshot: ReturnType<typeof openLegacySnapshot> | null = null;
  try {
    snapshot = openLegacySnapshot(config);
    if (snapshot.database.databaseFingerprint !== manifest.source.databaseFingerprint) {
      sourceFingerprintsMatch = false;
      anomalies.push(anomaly("inconsistent_snapshot", "database", "database fingerprint differs from the manifest"));
    }
    const catalogFingerprint = sha256Bytes(readBounded(snapshot.paths.catalogPath, MAX_CATALOG_BYTES, "legacy index.json"));
    if (catalogFingerprint !== manifest.source.catalogFingerprint) {
      sourceFingerprintsMatch = false;
      anomalies.push(anomaly("inconsistent_snapshot", "catalog", "catalog fingerprint differs from the manifest"));
    }
    const counts = catalogCounts(config);
    const expectedCounts = { cartridges: manifest.summary.cartridges, releases: manifest.summary.releases, artifacts: manifest.summary.artifacts };
    if (counts.cartridges !== expectedCounts.cartridges || counts.releases !== expectedCounts.releases || counts.artifacts !== expectedCounts.artifacts || Number(snapshot.database.rowCounts.cartridge_submissions ?? 0) !== manifest.summary.submissions || Number(snapshot.database.rowCounts.download_events ?? 0) !== manifest.summary.downloadEvents) {
      recordCountsMatch = false;
      anomalies.push(anomaly("record_count_mismatch", "snapshot", "current record counts differ from the manifest"));
    }
    for (const artifact of manifest.artifacts) {
      const resolved = resolveLegacyReference(snapshot.paths.root, snapshot.paths.dataRoot, artifact.sourceRef.replace(`${relativeSourceRef(snapshot.paths.root, snapshot.paths.dataRoot)}/`, ""));
      if (!resolved.safe || !fs.existsSync(resolved.absolutePath) || !fs.lstatSync(resolved.absolutePath).isFile()) {
        artifactFilesMatch = false;
        anomalies.push(anomaly("missing_referenced_artifact", artifact.legacyId, "referenced artifact is missing or unsafe during verification"));
        continue;
      }
      const file = hashFile({ sourceRef: artifact.sourceRef, absolutePath: resolved.absolutePath });
      if (file.sizeBytes !== artifact.sizeBytes || file.sha256 !== artifact.sha256) {
        artifactFilesMatch = false;
        anomalies.push(anomaly("artifact_hash_or_size_mismatch", artifact.legacyId, "referenced artifact hash or size differs from the manifest"));
      }
    }
    const files = actualFiles(config);
    const expectedFiles = [...manifest.sourceFiles].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
    if (canonicalJson(files) !== canonicalJson(expectedFiles) || stableFileFingerprint(files) !== manifest.source.storageInventoryFingerprint) {
      storageFilesMatch = false;
      anomalies.push(anomaly("storage_inventory_mismatch", "filesystem", "scanned source files differ from the manifest"));
    }
  } catch {
    sourceFingerprintsMatch = false;
    anomalies.push(anomaly("verification_source_unavailable", "snapshot", "snapshot could not be independently re-read"));
  } finally {
    snapshot?.close();
  }
  return { ok: manifestSha256Matches && sourceFingerprintsMatch && recordCountsMatch && artifactFilesMatch && storageFilesMatch && anomalies.length === 0, manifestSha256Matches, sourceFingerprintsMatch, recordCountsMatch, artifactFilesMatch, storageFilesMatch, anomalies };
}
