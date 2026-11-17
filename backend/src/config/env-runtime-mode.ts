import path from "node:path";

import {
  CANDIDATE_RUNTIME_AUTHORIZATION,
  CANDIDATE_RUNTIME_MODE,
  type CandidateRuntimeMode,
} from "../runtime/candidate.js";
import {
  CANONICAL_DISPOSABLE_READ_MODE,
  CANONICAL_OPERATIONAL_READ_MODE,
  CANONICAL_OPERATIONAL_WORKFLOW_MODE,
  CANONICAL_READ_AUTHORIZATION,
  CANONICAL_WORKFLOW_MODE,
  CANONICAL_WRITE_AUTHORIZATION,
  LEGACY_READ_MODE,
  type CatalogReadMode,
  type CanonicalWorkflowMode,
} from "../storage-v2/read-mode.js";
import { optionalNonEmpty, optionalSecret } from "./env-values.js";

/** Resolved canonical and candidate runtime mode policy. */
export interface RuntimeModeConfig {
  readonly catalogReadMode: CatalogReadMode;
  readonly canonicalStorageRoot: string | undefined;
  readonly canonicalReadAuthorization: string | undefined;
  readonly canonicalWorkflowMode: CanonicalWorkflowMode | undefined;
  readonly canonicalWriteAuthorization: string | undefined;
  readonly candidateRuntimeMode: CandidateRuntimeMode | undefined;
  readonly candidateRuntimeAuthorization: string | undefined;
}

/** Resolves the mode policy before domain-specific writer settings. */
export function resolveRuntimeMode(
  environment: NodeJS.ProcessEnv,
): RuntimeModeConfig {
  const catalogReadMode =
    optionalNonEmpty(environment.PRG32_BACKEND_CATALOG_READ_MODE) ??
    LEGACY_READ_MODE;
  if (
    catalogReadMode !== LEGACY_READ_MODE &&
    catalogReadMode !== CANONICAL_DISPOSABLE_READ_MODE &&
    catalogReadMode !== CANONICAL_OPERATIONAL_READ_MODE
  ) {
    throw new Error(
      "PRG32_BACKEND_CATALOG_READ_MODE must be legacy, " +
        "canonical-disposable, or canonical-operational",
    );
  }
  const canonicalStorageRoot = optionalNonEmpty(
    environment.PRG32_BACKEND_CANONICAL_STORAGE_ROOT,
  );
  const canonicalReadAuthorization = optionalSecret(
    environment,
    "PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION",
  );
  if (catalogReadMode === CANONICAL_DISPOSABLE_READ_MODE) {
    if (!canonicalStorageRoot) {
      throw new Error(
        "PRG32_BACKEND_CANONICAL_STORAGE_ROOT is required " +
          "in canonical-disposable mode",
      );
    }
    if (canonicalReadAuthorization !== CANONICAL_READ_AUTHORIZATION) {
      throw new Error(
        "PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION is invalid",
      );
    }
    if ((environment.NODE_ENV ?? "").trim().toLowerCase() === "production") {
      throw new Error(
        "canonical-disposable catalog mode is disabled in production",
      );
    }
  }
  const canonicalWorkflowMode = optionalNonEmpty(
    environment.PRG32_BACKEND_CANONICAL_WORKFLOW_MODE,
  );
  const canonicalWriteAuthorization = optionalSecret(
    environment,
    "PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION",
  );
  const candidateRuntimeMode = optionalNonEmpty(
    environment.PRG32_BACKEND_CANDIDATE_MODE,
  );
  const candidateRuntimeAuthorization = optionalNonEmpty(
    environment.PRG32_BACKEND_CANDIDATE_AUTHORIZATION,
  );
  if (
    candidateRuntimeMode !== undefined &&
    candidateRuntimeMode !== CANDIDATE_RUNTIME_MODE
  ) {
    throw new Error(
      "PRG32_BACKEND_CANDIDATE_MODE must be two-service-disposable",
    );
  }
  if (
    candidateRuntimeMode !== undefined &&
    candidateRuntimeAuthorization !== CANDIDATE_RUNTIME_AUTHORIZATION
  ) {
    throw new Error("PRG32_BACKEND_CANDIDATE_AUTHORIZATION is invalid");
  }
  if (
    canonicalWorkflowMode !== undefined &&
    canonicalWorkflowMode !== CANONICAL_WORKFLOW_MODE &&
    canonicalWorkflowMode !== CANONICAL_OPERATIONAL_WORKFLOW_MODE
  ) {
    throw new Error(
      "PRG32_BACKEND_CANONICAL_WORKFLOW_MODE must be disposable or operational",
    );
  }
  if (canonicalWorkflowMode === CANONICAL_WORKFLOW_MODE) {
    if (catalogReadMode !== CANONICAL_DISPOSABLE_READ_MODE) {
      throw new Error(
        "canonical workflow requires canonical-disposable catalog reads",
      );
    }
    if (
      !canonicalStorageRoot ||
      path.resolve(canonicalStorageRoot) !==
        path.resolve(environment.PRG32_BACKEND_CANONICAL_STORAGE_ROOT ?? "")
    ) {
      throw new Error(
        "canonical workflow requires the canonical storage root",
      );
    }
    if (canonicalReadAuthorization !== CANONICAL_READ_AUTHORIZATION) {
      throw new Error("canonical workflow requires canonical read authorization");
    }
    if (canonicalWriteAuthorization !== CANONICAL_WRITE_AUTHORIZATION) {
      throw new Error(
        "PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION is invalid",
      );
    }
    if ((environment.NODE_ENV ?? "").trim().toLowerCase() === "production") {
      throw new Error(
        "canonical disposable workflow is disabled in production",
      );
    }
  }
  return {
    catalogReadMode,
    canonicalStorageRoot,
    canonicalReadAuthorization,
    canonicalWorkflowMode,
    canonicalWriteAuthorization,
    candidateRuntimeMode,
    candidateRuntimeAuthorization,
  };
}
