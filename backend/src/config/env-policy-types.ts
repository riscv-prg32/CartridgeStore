import type { BackendConfig } from "./env-contracts.js";

/**
 * Resolved values used by the configuration policy validators.
 *
 * Parsing and domain-specific defaults remain in `env.ts` and the focused
 * resolver modules. This input contains only resolved values needed by the
 * writer and runtime-mode invariants.
 */
export interface ConfigurationPolicyInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly configuredDatabase: string;
  readonly configuredStoreData: string;
  readonly legacyConfiguredUserCount: number;
  readonly configuredCatalogReadMode: BackendConfig["catalogReadMode"];
  readonly canonicalStorageRoot: string | undefined;
  readonly canonicalWorkflowMode: BackendConfig["canonicalWorkflowMode"];
  readonly candidateRuntimeMode: BackendConfig["candidateRuntimeMode"];
  readonly operationalMode: boolean;
  readonly authWriteEnabled: boolean;
  readonly authWriteMode: string | undefined;
  readonly authWriteDatabasePath: string | undefined;
  readonly authDisposableRoot: string | undefined;
  readonly authSessionSecret: string | undefined;
  readonly authBootstrapToken: string | undefined;
  readonly federationLifecycleTestToken: string | undefined;
  readonly federationLifecycleTestEnabled: boolean;
  readonly secretEncryptionEnabled: boolean;
  readonly secretKeyRegistryPath: string | undefined;
  readonly submissionWriteEnabled: boolean;
  readonly submissionWriteMode: string | undefined;
  readonly submissionDisposableRoot: string | undefined;
  readonly metricsWriteEnabled: boolean;
  readonly metricsWriteMode: string | undefined;
  readonly metricsDisposableRoot: string | undefined;
  readonly scoresWriteEnabled: boolean;
  readonly scoresWriteMode: string | undefined;
  readonly scoresDisposableRoot: string | undefined;
  readonly backupEnabled: boolean;
  readonly backupMode: string | undefined;
  readonly mdnsEnabled: boolean;
  readonly trustProxy: boolean;
  readonly corsAllowedOrigins: readonly string[];
  readonly frontendPublicOrigin: string | undefined;
  readonly federationAutoProvision: boolean;
}

/** Input boundary for isolated writer invariants. */
export type WriterConfigurationInput = Pick<
  ConfigurationPolicyInput,
  | "environment"
  | "configuredDatabase"
  | "canonicalStorageRoot"
  | "canonicalWorkflowMode"
  | "candidateRuntimeMode"
  | "operationalMode"
  | "authWriteEnabled"
  | "authWriteMode"
  | "authWriteDatabasePath"
  | "authDisposableRoot"
  | "authSessionSecret"
  | "authBootstrapToken"
  | "federationLifecycleTestToken"
  | "federationLifecycleTestEnabled"
  | "secretEncryptionEnabled"
  | "secretKeyRegistryPath"
  | "submissionWriteEnabled"
  | "submissionWriteMode"
  | "submissionDisposableRoot"
  | "metricsWriteEnabled"
  | "metricsWriteMode"
  | "metricsDisposableRoot"
  | "scoresWriteEnabled"
  | "scoresWriteMode"
  | "scoresDisposableRoot"
  | "backupEnabled"
  | "backupMode"
>;

/** Input boundary for candidate and canonical-operational invariants. */
export type RuntimeConfigurationInput = Pick<
  ConfigurationPolicyInput,
  | "environment"
  | "configuredDatabase"
  | "configuredStoreData"
  | "legacyConfiguredUserCount"
  | "configuredCatalogReadMode"
  | "canonicalStorageRoot"
  | "canonicalWorkflowMode"
  | "candidateRuntimeMode"
  | "operationalMode"
  | "authWriteEnabled"
  | "authWriteMode"
  | "authWriteDatabasePath"
  | "authDisposableRoot"
  | "authSessionSecret"
  | "authBootstrapToken"
  | "federationLifecycleTestEnabled"
  | "secretEncryptionEnabled"
  | "secretKeyRegistryPath"
  | "backupEnabled"
  | "mdnsEnabled"
  | "trustProxy"
  | "corsAllowedOrigins"
  | "frontendPublicOrigin"
  | "federationAutoProvision"
>;
