import path from "node:path";

import {
  CANONICAL_WORKFLOW_MODE,
} from "../storage-v2/read-mode.js";
import { looksLikeSqliteUri, requiredSecret } from "./env-values.js";
import type { WriterConfigurationInput } from "./env-policy-types.js";

function isProduction(environment: NodeJS.ProcessEnv): boolean {
  return (environment.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

/**
 * Validates the isolated writer boundaries before network configuration is
 * resolved.
 */
export function validateWriterConfiguration(
  input: WriterConfigurationInput,
): void {
  const {
    authBootstrapToken,
    authDisposableRoot,
    authSessionSecret,
    authWriteDatabasePath,
    authWriteEnabled,
    authWriteMode,
    backupEnabled,
    backupMode,
    canonicalStorageRoot,
    canonicalWorkflowMode,
    configuredDatabase,
    environment,
    federationLifecycleTestEnabled,
    federationLifecycleTestToken,
    metricsDisposableRoot,
    metricsWriteEnabled,
    metricsWriteMode,
    operationalMode,
    scoresDisposableRoot,
    scoresWriteEnabled,
    scoresWriteMode,
    secretEncryptionEnabled,
    secretKeyRegistryPath,
    submissionDisposableRoot,
    submissionWriteEnabled,
    submissionWriteMode,
  } = input;

  if (authWriteEnabled) {
    if (
      authWriteMode !== "test" &&
      !(operationalMode && authWriteMode === "operational")
    ) {
      throw new Error(
        "PRG32_BACKEND_AUTH_WRITE_MODE must be test or operational " +
          "when auth writes are enabled",
      );
    }
    if (!authWriteDatabasePath) {
      throw new Error(
        "PRG32_BACKEND_AUTH_WRITE_DB is required when auth writes are enabled",
      );
    }
    if (!authDisposableRoot) {
      throw new Error(
        "PRG32_BACKEND_AUTH_DISPOSABLE_ROOT is required when auth writes are enabled",
      );
    }
    requiredSecret("PRG32_BACKEND_SESSION_SECRET", authSessionSecret);
    if (authBootstrapToken) {
      requiredSecret("PRG32_BACKEND_BOOTSTRAP_TOKEN", authBootstrapToken);
    }
    if (federationLifecycleTestToken && federationLifecycleTestToken.length < 32) {
      throw new Error(
        "PRG32_BACKEND_FEDERATION_LIFECYCLE_TEST_TOKEN must contain at least 32 characters",
      );
    }
    if (federationLifecycleTestEnabled && !federationLifecycleTestToken) {
      throw new Error(
        "PRG32_BACKEND_FEDERATION_LIFECYCLE_TEST_TOKEN is required when lifecycle test routes are enabled",
      );
    }
    if (looksLikeSqliteUri(authWriteDatabasePath)) {
      throw new Error(
        "SQLite URI syntax is not allowed for the auth write database",
      );
    }
    if (
      path.resolve(authWriteDatabasePath) === path.resolve(configuredDatabase) &&
      canonicalWorkflowMode !== CANONICAL_WORKFLOW_MODE &&
      input.candidateRuntimeMode === undefined &&
      !operationalMode
    ) {
      throw new Error(
        "auth write database must be separate from the shadow database",
      );
    }
    if (canonicalWorkflowMode === CANONICAL_WORKFLOW_MODE || operationalMode) {
      const canonicalRoot = path.resolve(canonicalStorageRoot as string);
      if (
        path.resolve(authDisposableRoot) !== canonicalRoot ||
        path.resolve(authWriteDatabasePath) !==
          path.join(canonicalRoot, "store.sqlite")
      ) {
        throw new Error(
          "canonical workflow authentication must use the canonical storage-v2 database",
        );
      }
    }
  }
  if (
    (canonicalWorkflowMode === CANONICAL_WORKFLOW_MODE || operationalMode) &&
    !authWriteEnabled
  ) {
    throw new Error(
      "canonical workflow requires the canonical authentication writer",
    );
  }
  if (
    federationLifecycleTestEnabled &&
    (authWriteMode !== "test" ||
      !authWriteEnabled ||
      !authDisposableRoot ||
      !authWriteDatabasePath)
  ) {
    throw new Error(
      "federation lifecycle test routes require the isolated auth writer configuration",
    );
  }
  if (isProduction(environment) && federationLifecycleTestEnabled) {
    throw new Error(
      "federation lifecycle test routes cannot be enabled in production",
    );
  }
  if (secretEncryptionEnabled && !secretKeyRegistryPath) {
    throw new Error(
      "PRG32_BACKEND_SECRET_KEY_REGISTRY is required when secret encryption is enabled",
    );
  }
  if (submissionWriteEnabled) {
    if (submissionWriteMode !== "test") {
      throw new Error(
        "PRG32_BACKEND_SUBMISSION_WRITE_MODE must be test when submission writes are enabled",
      );
    }
    if (!authWriteEnabled) {
      throw new Error("submission writes require isolated authentication writes");
    }
    if (!submissionDisposableRoot) {
      throw new Error(
        "PRG32_BACKEND_SUBMISSION_DISPOSABLE_ROOT is required when submission writes are enabled",
      );
    }
    if (path.resolve(submissionDisposableRoot) === path.resolve(configuredDatabase)) {
      throw new Error(
        "submission disposable root must be separate from the shadow database",
      );
    }
  }
  if (metricsWriteEnabled) {
    if (metricsWriteMode !== "test") {
      throw new Error(
        "PRG32_BACKEND_METRICS_WRITE_MODE must be test when metrics writes are enabled",
      );
    }
    if (!authWriteEnabled || !authDisposableRoot || !authWriteDatabasePath) {
      throw new Error("metrics writes require isolated authentication writes");
    }
    if (!metricsDisposableRoot) {
      throw new Error(
        "PRG32_BACKEND_METRICS_DISPOSABLE_ROOT is required when metrics writes are enabled",
      );
    }
    if (path.resolve(metricsDisposableRoot) !== path.resolve(authDisposableRoot)) {
      throw new Error(
        "metrics disposable root must reuse the authenticated disposable writer boundary",
      );
    }
  }
  if (scoresWriteEnabled) {
    if (scoresWriteMode !== "test") {
      throw new Error(
        "PRG32_BACKEND_SCORES_WRITE_MODE must be test when score writes are enabled",
      );
    }
    if (!authWriteEnabled || !authDisposableRoot || !authWriteDatabasePath) {
      throw new Error("score writes require isolated authentication writes");
    }
    if (!scoresDisposableRoot) {
      throw new Error(
        "PRG32_BACKEND_SCORES_DISPOSABLE_ROOT is required when score writes are enabled",
      );
    }
    if (path.resolve(scoresDisposableRoot) !== path.resolve(authDisposableRoot)) {
      throw new Error(
        "score disposable root must reuse the authenticated disposable writer boundary",
      );
    }
  }
  if (backupEnabled) {
    if (backupMode !== "test") {
      throw new Error(
        "PRG32_BACKEND_BACKUP_MODE must be test when backup is enabled",
      );
    }
    if (!authWriteEnabled || authWriteMode !== "test") {
      throw new Error(
        "backup requires the isolated authentication writer profile",
      );
    }
  }
}
