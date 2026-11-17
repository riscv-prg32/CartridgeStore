export const CANONICAL_DISPOSABLE_READ_MODE = "canonical-disposable" as const;
export const CANONICAL_OPERATIONAL_READ_MODE = "canonical-operational" as const;
export const LEGACY_READ_MODE = "legacy" as const;
export const CANONICAL_READ_AUTHORIZATION = "M5.2G1-DISPOSABLE-CANONICAL-READ";
export const CANONICAL_WORKFLOW_MODE = "disposable" as const;
export const CANONICAL_OPERATIONAL_WORKFLOW_MODE = "operational" as const;
export const CANONICAL_WRITE_AUTHORIZATION = "M5.2G2-DISPOSABLE-CANONICAL-WRITE";

export type CatalogReadMode = typeof LEGACY_READ_MODE | typeof CANONICAL_DISPOSABLE_READ_MODE | typeof CANONICAL_OPERATIONAL_READ_MODE;
export type CanonicalWorkflowMode = typeof CANONICAL_WORKFLOW_MODE | typeof CANONICAL_OPERATIONAL_WORKFLOW_MODE;
