import path from "node:path";

import { parseLegacyConfiguredUsers } from "../auth/tokens.js";
import { CANDIDATE_RUNTIME_MODE } from "../runtime/candidate.js";
import { CANONICAL_DISPOSABLE_READ_MODE, CANONICAL_OPERATIONAL_READ_MODE, CANONICAL_OPERATIONAL_WORKFLOW_MODE, CANONICAL_WORKFLOW_MODE } from "../storage-v2/read-mode.js";
import {
  booleanValue,
  nonEmpty,
  optionalNonEmpty,
  optionalSecret,
  positiveInteger,
} from "./env-values.js";
import type { BackendConfig } from "./env-contracts.js";
import { resolveAuthLimitsConfig } from "./env-auth-limits.js";
import { resolveBackupLimitsConfig } from "./env-backup-limits.js";
import { resolveEmailConfig } from "./env-email.js";
import { resolveHttpLimitsConfig } from "./env-http-limits.js";
import { resolveMetricsLimitsConfig } from "./env-metrics-limits.js";
import { resolveMultiplayerConfig } from "./env-multiplayer.js";
import {
  resolvePublicOriginConfig,
  validatePublicOriginConfig,
} from "./env-origins.js";
import { resolveRuntimeMode } from "./env-runtime-mode.js";
import { resolveNetworkConfig } from "./env-network.js";
import { resolveSessionCookieConfig } from "./env-session.js";
import { resolveSamlLimitsConfig } from "./env-saml-limits.js";
import { resolveScoresLimitsConfig } from "./env-scores-limits.js";
import { resolveSecretLimitsConfig } from "./env-secret-limits.js";
import { resolveSubmissionLimitsConfig } from "./env-submission-limits.js";
import { resolveWebAuthnConfig } from "./env-webauthn.js";
import {
  validateRuntimeConfiguration,
  validateWriterConfiguration,
} from "./env-policy.js";

export type { BackendConfig } from "./env-contracts.js";

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BackendConfig {
  const configuredDatabase = nonEmpty(
    "PRG32_BACKEND_DB",
    environment.PRG32_BACKEND_DB,
    path.resolve(process.cwd(), "data", "cartridge" + "_store.sqlite")
  );
  const configuredStoreData = nonEmpty(
    "PRG32_BACKEND_STORE_DATA",
    environment.PRG32_BACKEND_STORE_DATA ?? environment.PRG32_STORE_DATA,
    path.resolve(process.cwd(), "data")
  );
  const legacyConfiguredUsers = parseLegacyConfiguredUsers(environment.PRG32_USERS);
  const {
    catalogReadMode: configuredCatalogReadMode,
    canonicalStorageRoot,
    canonicalReadAuthorization,
    canonicalWorkflowMode,
    canonicalWriteAuthorization,
    candidateRuntimeMode,
    candidateRuntimeAuthorization,
  } = resolveRuntimeMode(environment);
  const operationalMode = configuredCatalogReadMode === CANONICAL_OPERATIONAL_READ_MODE || canonicalWorkflowMode === CANONICAL_OPERATIONAL_WORKFLOW_MODE;
  if (operationalMode) {
    if (configuredCatalogReadMode !== CANONICAL_OPERATIONAL_READ_MODE || canonicalWorkflowMode !== CANONICAL_OPERATIONAL_WORKFLOW_MODE) throw new Error("canonical operational mode requires canonical-operational reads and workflow");
    if (!canonicalStorageRoot) throw new Error("PRG32_BACKEND_CANONICAL_STORAGE_ROOT is required in canonical-operational mode");
    if (!canonicalReadAuthorization || canonicalReadAuthorization.length < 32) throw new Error("PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION must contain at least 32 characters in canonical-operational mode");
    if (!canonicalWriteAuthorization || canonicalWriteAuthorization.length < 32) throw new Error("PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION must contain at least 32 characters in canonical-operational mode");
  }

  const authWriteEnabled = booleanValue(
    "PRG32_BACKEND_AUTH_WRITE_ENABLED",
    environment.PRG32_BACKEND_AUTH_WRITE_ENABLED,
    false
  );
  const authWriteMode = optionalNonEmpty(environment.PRG32_BACKEND_AUTH_WRITE_MODE);
  const authWriteDatabasePath = optionalNonEmpty(environment.PRG32_BACKEND_AUTH_WRITE_DB);
  const authDisposableRoot = optionalNonEmpty(environment.PRG32_BACKEND_AUTH_DISPOSABLE_ROOT);
  const authSessionSecret = optionalSecret(
    environment,
    "PRG32_BACKEND_SESSION_SECRET",
  );
  const federationAutoProvision = booleanValue(
    "PRG32_BACKEND_FEDERATION_AUTO_PROVISION",
    environment.PRG32_BACKEND_FEDERATION_AUTO_PROVISION,
    false
  );
  if (federationAutoProvision && (!authWriteEnabled || authWriteMode !== "test" || (environment.NODE_ENV ?? "").trim().toLowerCase() === "production")) {
    throw new Error("federation auto-provisioning is restricted to the isolated non-production auth writer");
  }
  const authBootstrapToken = optionalSecret(
    environment,
    "PRG32_BACKEND_BOOTSTRAP_TOKEN",
  );
  const federationLifecycleTestToken = optionalSecret(
    environment,
    "PRG32_BACKEND_FEDERATION_LIFECYCLE_TEST_TOKEN",
  );
  const federationLifecycleTestEnabled = booleanValue(
    "PRG32_BACKEND_FEDERATION_LIFECYCLE_TEST_ENABLED",
    environment.PRG32_BACKEND_FEDERATION_LIFECYCLE_TEST_ENABLED,
    false
  );
  const {
    oidcPublicOrigin,
    federationPublicOrigin,
    frontendPublicOrigin,
    corsAllowedOrigins,
  } = resolvePublicOriginConfig(
    environment,
  );
  const {
    emailTransport,
    emailFrom,
    emailPublicOrigin,
    emailSmtpHost,
    emailSmtpPort,
    emailSmtpUser,
    emailSmtpPassword,
  } = resolveEmailConfig(
    environment,
    authWriteMode,
    frontendPublicOrigin,
  );
  const {
    webauthnEnabled,
    webauthnRpId,
    webauthnRpName,
    webauthnOrigins,
    setupNetworkTestAllowlist,
  } = resolveWebAuthnConfig(environment, authWriteEnabled);
  validatePublicOriginConfig(
    environment,
    {
      oidcPublicOrigin,
      federationPublicOrigin,
      frontendPublicOrigin,
      corsAllowedOrigins,
    },
    authWriteMode,
    operationalMode,
  );
  const secretEncryptionEnabled = booleanValue(
    "PRG32_BACKEND_SECRET_ENCRYPTION_ENABLED",
    environment.PRG32_BACKEND_SECRET_ENCRYPTION_ENABLED,
    false
  );
  const secretKeyRegistryPath = optionalNonEmpty(environment.PRG32_BACKEND_SECRET_KEY_REGISTRY);
  const submissionWriteEnabled = booleanValue(
    "PRG32_BACKEND_SUBMISSION_WRITE_ENABLED",
    environment.PRG32_BACKEND_SUBMISSION_WRITE_ENABLED,
    false
  );
  const submissionWriteMode = optionalNonEmpty(environment.PRG32_BACKEND_SUBMISSION_WRITE_MODE);
  const submissionDisposableRoot = optionalNonEmpty(environment.PRG32_BACKEND_SUBMISSION_DISPOSABLE_ROOT);
  const metricsWriteEnabled = booleanValue(
    "PRG32_BACKEND_METRICS_WRITE_ENABLED",
    environment.PRG32_BACKEND_METRICS_WRITE_ENABLED,
    false
  );
  const metricsWriteMode = optionalNonEmpty(environment.PRG32_BACKEND_METRICS_WRITE_MODE);
  const metricsDisposableRoot = optionalNonEmpty(environment.PRG32_BACKEND_METRICS_DISPOSABLE_ROOT);
  const scoresWriteEnabled = booleanValue(
    "PRG32_BACKEND_SCORES_WRITE_ENABLED",
    environment.PRG32_BACKEND_SCORES_WRITE_ENABLED,
    false
  );
  const scoresWriteMode = optionalNonEmpty(environment.PRG32_BACKEND_SCORES_WRITE_MODE);
  const scoresDisposableRoot = optionalNonEmpty(environment.PRG32_BACKEND_SCORES_DISPOSABLE_ROOT);
  const backupEnabled = booleanValue(
    "PRG32_BACKEND_BACKUP_ENABLED",
    environment.PRG32_BACKEND_BACKUP_ENABLED,
    false
  );
  const backupMode = optionalNonEmpty(environment.PRG32_BACKEND_BACKUP_MODE);
  validateWriterConfiguration({
    environment,
    configuredDatabase,
    canonicalStorageRoot,
    canonicalWorkflowMode,
    candidateRuntimeMode,
    operationalMode,
    authWriteEnabled,
    authWriteMode,
    authWriteDatabasePath,
    authDisposableRoot,
    authSessionSecret,
    authBootstrapToken,
    federationLifecycleTestToken,
    federationLifecycleTestEnabled,
    secretEncryptionEnabled,
    secretKeyRegistryPath,
    submissionWriteEnabled,
    submissionWriteMode,
    submissionDisposableRoot,
    metricsWriteEnabled,
    metricsWriteMode,
    metricsDisposableRoot,
    scoresWriteEnabled,
    scoresWriteMode,
    scoresDisposableRoot,
    backupEnabled,
    backupMode,
  });
  const {
    authCookieSecure,
    authCookieSameSite,
    authCookieDomain,
  } = resolveSessionCookieConfig(environment);
  const {
    mdnsEnabled,
    trustProxy,
    trustProxyHops,
    trustedProxyCidrs,
    mdnsInterface,
  } = resolveNetworkConfig(environment);
  validateRuntimeConfiguration({
    environment,
    configuredDatabase,
    configuredStoreData,
    legacyConfiguredUserCount: legacyConfiguredUsers.length,
    configuredCatalogReadMode,
    canonicalStorageRoot,
    canonicalWorkflowMode,
    candidateRuntimeMode,
    operationalMode,
    authWriteEnabled,
    authWriteMode,
    authWriteDatabasePath,
    authDisposableRoot,
    authSessionSecret,
    authBootstrapToken,
    federationLifecycleTestEnabled,
    secretEncryptionEnabled,
    secretKeyRegistryPath,
    backupEnabled,
    mdnsEnabled,
    trustProxy,
    corsAllowedOrigins,
    frontendPublicOrigin,
    federationAutoProvision,
  });
  const mdnsHost = optionalNonEmpty(environment.PRG32_BACKEND_MDNS_HOST);
  const mdnsPort = positiveInteger(
    "PRG32_BACKEND_MDNS_PORT",
    environment.PRG32_BACKEND_MDNS_PORT ?? environment.PRG32_STORE_PORT ?? environment.PRG32_BACKEND_PORT,
    5090
  );

  return {
    host: nonEmpty("PRG32_BACKEND_HOST", environment.PRG32_BACKEND_HOST, "127.0.0.1"),
    port: positiveInteger("PRG32_BACKEND_PORT", environment.PRG32_BACKEND_PORT, 5090),
    logLevel: nonEmpty("PRG32_BACKEND_LOG_LEVEL", environment.PRG32_BACKEND_LOG_LEVEL, "info"),
    trustProxy,
    trustProxyHops,
    trustedProxyCidrs,
    databasePath: path.resolve(configuredDatabase),
    storeDataDirectory: path.resolve(configuredStoreData),
    storePortOverride: environment.PRG32_STORE_PORT?.trim() || undefined,
    storeName: nonEmpty("PRG32_STORE_NAME", environment.PRG32_STORE_NAME, "PRG32 Cartridge Store"),
    storeVersion: nonEmpty("PRG32_STORE_VERSION", environment.PRG32_STORE_VERSION, "1.0.0"),
    firmwareRepository: nonEmpty(
      "PRG32_BACKEND_FIRMWARE_REPOSITORY",
      environment.PRG32_BACKEND_FIRMWARE_REPOSITORY,
      "riscv-prg32/PRG32"
    ),
    firmwareDirectory: optionalNonEmpty(environment.PRG32_BACKEND_FIRMWARE_DIRECTORY)
      ? path.resolve(optionalNonEmpty(environment.PRG32_BACKEND_FIRMWARE_DIRECTORY) as string)
      : undefined,
    firmwareListTtlSeconds: positiveInteger(
      "PRG32_BACKEND_FIRMWARE_LIST_TTL_SECONDS",
      environment.PRG32_BACKEND_FIRMWARE_LIST_TTL_SECONDS,
      600
    ),
    firmwareHttpTimeoutMs: positiveInteger(
      "PRG32_BACKEND_FIRMWARE_HTTP_TIMEOUT_MS",
      environment.PRG32_BACKEND_FIRMWARE_HTTP_TIMEOUT_MS,
      30_000
    ),
    firmwareGithubToken: optionalSecret(environment, "PRG32_BACKEND_FIRMWARE_GITHUB_TOKEN"),
    mdnsEnabled,
    mdnsName: nonEmpty("PRG32_BACKEND_MDNS_NAME", environment.PRG32_BACKEND_MDNS_NAME, environment.PRG32_STORE_NAME ?? "PRG32 Cartridge Store"),
    mdnsHost,
    mdnsPort,
    mdnsInterface: mdnsInterface ?? "",
    ...resolveMultiplayerConfig(environment),
    legacyConfiguredUsers,
    busyTimeoutMs: positiveInteger(
      "PRG32_BACKEND_BUSY_TIMEOUT_MS",
      environment.PRG32_BACKEND_BUSY_TIMEOUT_MS,
      5000
    ),
    authWriteEnabled,
    authWriteMode,
    authWriteDatabasePath: authWriteEnabled ? path.resolve(authWriteDatabasePath as string) : undefined,
    authDisposableRoot: authWriteEnabled ? path.resolve(authDisposableRoot as string) : undefined,
    authSessionSecret: authWriteEnabled ? authSessionSecret : undefined,
    authCookieSecure,
    authCookieSameSite,
    authCookieDomain,
    ...resolveAuthLimitsConfig(environment),
    federationAutoProvision,
    authBootstrapToken,
    federationLifecycleTestToken: authWriteMode === "test" ? federationLifecycleTestToken : undefined,
    federationLifecycleTestEnabled,
    webauthnEnabled,
    webauthnRpId,
    webauthnRpName,
    webauthnOrigins,
    setupNetworkTestAllowlist,
    ...resolveHttpLimitsConfig(environment),
    emailTransport,
    emailFrom,
    emailPublicOrigin,
    emailSmtpHost,
    emailSmtpPort,
    emailSmtpUser,
    emailSmtpPassword,
    oidcPublicOrigin,
    federationPublicOrigin,
    frontendPublicOrigin,
    corsAllowedOrigins,
    ...resolveSamlLimitsConfig(environment),
    secretEncryptionEnabled,
    secretKeyRegistryPath: secretKeyRegistryPath ? path.resolve(secretKeyRegistryPath) : undefined,
    ...resolveSecretLimitsConfig(environment),
    submissionWriteEnabled,
    submissionWriteMode,
    submissionDisposableRoot: submissionWriteEnabled ? path.resolve(submissionDisposableRoot as string) : undefined,
    ...resolveSubmissionLimitsConfig(environment),
    metricsWriteEnabled,
    metricsWriteMode,
    metricsDisposableRoot: metricsWriteEnabled ? path.resolve(metricsDisposableRoot as string) : undefined,
    ...resolveMetricsLimitsConfig(environment),
    scoresWriteEnabled,
    scoresWriteMode,
    scoresDisposableRoot: scoresWriteEnabled ? path.resolve(scoresDisposableRoot as string) : undefined,
    ...resolveScoresLimitsConfig(environment),
    backupEnabled,
    backupMode,
    ...resolveBackupLimitsConfig(environment),
    catalogReadMode: configuredCatalogReadMode,
    canonicalStorageRoot: configuredCatalogReadMode === CANONICAL_DISPOSABLE_READ_MODE || configuredCatalogReadMode === CANONICAL_OPERATIONAL_READ_MODE ? path.resolve(canonicalStorageRoot as string) : undefined,
    canonicalReadAuthorization: configuredCatalogReadMode === CANONICAL_DISPOSABLE_READ_MODE || configuredCatalogReadMode === CANONICAL_OPERATIONAL_READ_MODE ? canonicalReadAuthorization : undefined,
    canonicalWorkflowMode,
    canonicalWriteAuthorization: canonicalWorkflowMode === CANONICAL_WORKFLOW_MODE || canonicalWorkflowMode === CANONICAL_OPERATIONAL_WORKFLOW_MODE ? canonicalWriteAuthorization : undefined,
    candidateRuntimeMode,
    candidateRuntimeAuthorization: candidateRuntimeMode === CANDIDATE_RUNTIME_MODE ? candidateRuntimeAuthorization : undefined
  };
}
