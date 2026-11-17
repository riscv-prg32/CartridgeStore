import path from "node:path";

import {
  CANONICAL_DISPOSABLE_READ_MODE,
  CANONICAL_WORKFLOW_MODE,
} from "../storage-v2/read-mode.js";
import { requiredSecret } from "./env-values.js";
import type {
  ConfigurationPolicyInput,
  RuntimeConfigurationInput,
} from "./env-policy-types.js";

function isProduction(environment: NodeJS.ProcessEnv): boolean {
  return (environment.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

function hasLegacyConfiguration(
  input: Pick<
    ConfigurationPolicyInput,
    "environment" | "legacyConfiguredUserCount"
  >,
): boolean {
  const { environment } = input;
  return input.legacyConfiguredUserCount > 0 ||
    environment.PRG32_USERS !== undefined ||
    environment.PRG32_SCORE_DB !== undefined ||
    environment.PRG32_METRICS_DB !== undefined ||
    environment.PRG32_STORE_DATA !== undefined ||
    environment.PRG32_STORE_DB !== undefined;
}

/**
 * Validates candidate and canonical-operational runtime ownership boundaries.
 */
export function validateRuntimeConfiguration(
  input: RuntimeConfigurationInput,
): void {
  const {
    authBootstrapToken,
    authWriteEnabled,
    authWriteMode,
    canonicalStorageRoot,
    canonicalWorkflowMode,
    configuredCatalogReadMode,
    configuredDatabase,
    configuredStoreData,
    corsAllowedOrigins,
    environment,
    federationAutoProvision,
    federationLifecycleTestEnabled,
    frontendPublicOrigin,
    mdnsEnabled,
    operationalMode,
    secretEncryptionEnabled,
    secretKeyRegistryPath,
    trustProxy,
  } = input;

  if (input.candidateRuntimeMode !== undefined) {
    const candidateRoot = path.resolve(canonicalStorageRoot ?? "");
    const canonicalDatabase = path.join(candidateRoot, "store.sqlite");
    if (isProduction(environment)) {
      throw new Error(
        "the two-service disposable candidate is disabled in production",
      );
    }
    if (
      configuredCatalogReadMode !== CANONICAL_DISPOSABLE_READ_MODE ||
      canonicalWorkflowMode !== CANONICAL_WORKFLOW_MODE
    ) {
      throw new Error(
        "the two-service candidate requires canonical disposable workflow mode",
      );
    }
    if (
      path.resolve(configuredDatabase) !== canonicalDatabase ||
      path.resolve(configuredStoreData) !== candidateRoot
    ) {
      throw new Error(
        "the two-service candidate requires one canonical root and store.sqlite database",
      );
    }
    if (
      !authWriteEnabled ||
      path.resolve(input.authDisposableRoot ?? "") !== candidateRoot ||
      path.resolve(input.authWriteDatabasePath ?? "") !== canonicalDatabase
    ) {
      throw new Error(
        "the two-service candidate requires the canonical SQLite writer boundary",
      );
    }
    if (hasLegacyConfiguration(input)) {
      throw new Error(
        "legacy database and configured-user fallbacks are disabled in the two-service candidate",
      );
    }
    if (mdnsEnabled) {
      throw new Error("mDNS must remain disabled in the two-service candidate");
    }
    if (input.backupEnabled) {
      throw new Error(
        "public backup support is disabled in the two-service candidate",
      );
    }
  }
  if (operationalMode) {
    if (input.candidateRuntimeMode !== undefined) {
      throw new Error(
        "candidate runtime mode cannot be combined with canonical-operational mode",
      );
    }
    if (hasLegacyConfiguration(input)) {
      throw new Error(
        "legacy database and configured-user fallbacks are disabled in canonical-operational mode",
      );
    }
    const canonicalRoot = path.resolve(canonicalStorageRoot as string);
    if (
      path.resolve(configuredDatabase) !== path.join(canonicalRoot, "store.sqlite") ||
      path.resolve(configuredStoreData) !== canonicalRoot
    ) {
      throw new Error(
        "canonical-operational mode requires one canonical root and store.sqlite database",
      );
    }
    if (authWriteMode !== "operational" || !authWriteEnabled) {
      throw new Error(
        "canonical-operational mode requires the operational canonical auth writer",
      );
    }
    if (!trustProxy) {
      throw new Error(
        "canonical-operational mode requires PRG32_BACKEND_TRUST_PROXY to be enabled",
      );
    }
    if (
      corsAllowedOrigins.some(
        (origin) => origin === "*" || origin !== frontendPublicOrigin,
      )
    ) {
      throw new Error(
        "canonical-operational mode requires an exact CORS allowlist matching PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN",
      );
    }
    if (mdnsEnabled) {
      throw new Error("mDNS must remain disabled in canonical-operational mode");
    }
    if (federationLifecycleTestEnabled || federationAutoProvision) {
      throw new Error(
        "test federation lifecycle and auto-provisioning are disabled in canonical-operational mode",
      );
    }
    requiredSecret("PRG32_BACKEND_SESSION_SECRET", input.authSessionSecret);
    if (!authBootstrapToken) {
      throw new Error(
        "PRG32_BACKEND_BOOTSTRAP_TOKEN is required in canonical-operational mode",
      );
    }
    requiredSecret("PRG32_BACKEND_BOOTSTRAP_TOKEN", authBootstrapToken);
    if (!secretEncryptionEnabled || !secretKeyRegistryPath) {
      throw new Error(
        "canonical-operational mode requires external secret encryption key configuration",
      );
    }
  }
}
