import fs from "node:fs";
import path from "node:path";

import { isDisposablePath } from "../database.js";
import {
  parseBoundedJson,
  resolveLegacyReference,
} from "../legacy/filesystem.js";
import { verifyLegacyManifest } from "../legacy/manifest.js";
import {
  MAX_MANIFEST_BYTES,
  type LegacyManifest,
  type LegacySnapshotConfig,
} from "../legacy/types.js";
import {
  TARGET_SCHEMA_VERSION,
  TARGET_STORAGE_LAYOUT_VERSION,
} from "../types.js";
import { MigrationError } from "./errors.js";
import type { MigrationConfig } from "./types.js";

const SAFE_SOURCE_REF =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Resolves a verified legacy source reference as a regular file. */
export function sourceFilePath(
  config: LegacySnapshotConfig,
  sourceRef: string,
): string {
  if (!SAFE_SOURCE_REF.test(sourceRef)) {
    throw new MigrationError(
      "source reference is unsafe",
      "migration_source_path_unsafe",
    );
  }
  const root = path.resolve(config.root);
  const resolved = resolveLegacyReference(root, root, sourceRef);
  if (!resolved.safe || !fs.existsSync(resolved.absolutePath)) {
    throw new MigrationError(
      "source reference is unavailable",
      "migration_source_file_missing",
    );
  }
  const stats = fs.lstatSync(resolved.absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new MigrationError(
      "source reference is not a regular file",
      "migration_source_file_unsafe",
    );
  }
  return resolved.absolutePath;
}

/** Resolves a migration target path while rejecting traversal and symlinks. */
export function targetFilePath(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (
    !isInside(root, target) ||
    relative.includes("..") ||
    path.isAbsolute(relative)
  ) {
    throw new MigrationError(
      "target staging path is unsafe",
      "migration_target_path_unsafe",
    );
  }
  let current = root;
  for (const part of path
    .relative(root, target)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new MigrationError(
        "target staging path contains a symlink",
        "migration_target_path_unsafe",
      );
    }
  }
  return target;
}

/** Validates the migration manifest against the supported target versions. */
export function validateMigrationManifest(manifest: LegacyManifest): void {
  if (
    manifest.manifestAbi !== "prg32-storage-migration-manifest-1.0" ||
    manifest.manifestVersion !== 1
  ) {
    throw new MigrationError(
      "manifest ABI is unsupported",
      "migration_manifest_unsupported",
    );
  }
  if (
    manifest.target.schemaVersion !== TARGET_SCHEMA_VERSION ||
    manifest.target.storageLayoutVersion !== TARGET_STORAGE_LAYOUT_VERSION
  ) {
    throw new MigrationError(
      "manifest target version is incompatible",
      "migration_manifest_target_incompatible",
    );
  }
  if (
    !manifest.readiness.inventoryComplete ||
    !manifest.readiness.migrationReady ||
    manifest.readiness.operationalCutoverReady !== false ||
    manifest.readiness.blockingAnomalyCount !== 0
  ) {
    throw new MigrationError(
      "manifest is not migration-ready",
      "migration_manifest_not_ready",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.manifestSha256)) {
    throw new MigrationError(
      "manifest fingerprint is invalid",
      "migration_manifest_invalid",
    );
  }
}

/** Loads the explicit verified manifest configured for a migration. */
export function loadMigrationManifest(config: MigrationConfig): LegacyManifest {
  if (config.manifest) return config.manifest;
  if (!config.manifestPath) {
    throw new MigrationError(
      "verified manifest path is required",
      "migration_manifest_required",
    );
  }
  const parsed = parseBoundedJson(
    path.resolve(config.manifestPath),
    MAX_MANIFEST_BYTES,
    "migration manifest",
  );
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MigrationError(
      "manifest must be an object",
      "migration_manifest_invalid",
    );
  }
  return parsed as LegacyManifest;
}

/** Validates disposable source/target roots and rejects overlapping paths. */
export function validateMigrationRoots(config: MigrationConfig): string {
  const source = path.resolve(config.snapshot.root);
  const target = path.resolve(config.targetRoot);
  if (
    !source ||
    !target ||
    source === path.parse(source).root ||
    target === path.parse(target).root
  ) {
    throw new MigrationError(
      "source and target roots must be explicit non-root directories",
      "migration_root_unsafe",
    );
  }
  if (
    !isDisposablePath(target) ||
    target === path.resolve(process.cwd()) ||
    isInside(process.cwd(), target)
  ) {
    throw new MigrationError(
      "target root is not a disposable path",
      "migration_target_forbidden",
    );
  }
  if (
    source === target ||
    isInside(source, target) ||
    isInside(target, source)
  ) {
    throw new MigrationError(
      "source and target roots overlap",
      "migration_root_overlap",
    );
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new MigrationError(
      "target root may not be a symlink",
      "migration_target_symlink",
    );
  }
  if (fs.existsSync(source) && fs.lstatSync(source).isSymbolicLink()) {
    throw new MigrationError(
      "source root may not be a symlink",
      "migration_source_symlink",
    );
  }
  return target;
}

/** Verifies that the legacy snapshot still matches its approved manifest. */
export function verifyMigrationSource(
  config: MigrationConfig,
  manifest: LegacyManifest,
): void {
  const verification = verifyLegacyManifest(config.snapshot, manifest);
  if (!verification.ok) {
    throw new MigrationError(
      "legacy manifest verification failed",
      "migration_source_verification_failed",
    );
  }
}
