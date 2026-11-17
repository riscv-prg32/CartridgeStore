/**
 * Explicit guard values for the disposable two-service runtime candidate.
 *
 * These values are intentionally not secrets. They are a human-visible
 * authorization boundary which prevents accidentally starting candidate mode
 * against an operational or legacy data root.
 */
export const CANDIDATE_RUNTIME_MODE = "two-service-disposable" as const;
export const CANDIDATE_RUNTIME_AUTHORIZATION = "M5.2G9-DISPOSABLE-TWO-SERVICE-CANDIDATE" as const;

export type CandidateRuntimeMode = typeof CANDIDATE_RUNTIME_MODE;
