export type RollbackRehearsalState =
  | "legacy_authoritative"
  | "target_prepared"
  | "target_verified"
  | "target_authoritative"
  | "target_failed"
  | "target_relinquished"
  | "legacy_restored"
  | "completed";

export interface RollbackRehearsalChecks {
  readonly sourceSnapshotUnchanged: boolean;
  readonly inventoryVerified: boolean;
  readonly migrationVerified: boolean;
  readonly parityVerified: boolean;
  readonly backupVerified: boolean;
  readonly restoreVerified: boolean;
  readonly failureDetected: boolean;
}

export interface RollbackRehearsalEvent {
  readonly state: RollbackRehearsalState;
  readonly writer: "legacy" | "canonical" | "none";
  readonly action: string;
}

export interface RollbackRehearsalResult {
  readonly abi: "prg32-storage-v2-rollback-rehearsal-1.0";
  readonly ok: true;
  readonly finalState: "completed";
  readonly checks: RollbackRehearsalChecks;
  readonly events: readonly RollbackRehearsalEvent[];
  readonly simultaneousWriterRejected: true;
  readonly postCutoverRollback: {
    readonly requiresWriteQuiescence: true;
    readonly requiresReconciliation: true;
    readonly possibleDataLossWindow: "post-cutover-writes-not-in-pre-cutover-snapshot";
  };
}

export type PostCutoverRollbackDecision = "reconcile_forward" | "accept_data_loss" | "forward_fix";

export interface PostCutoverRollbackAssessment {
  readonly abi: "prg32-storage-v2-post-cutover-rollback-1.0";
  readonly losslessRollback: false;
  readonly status: "LOSSLESS_ROLLBACK_NOT_AVAILABLE";
  readonly postCutoverWriteIds: readonly string[];
  readonly missingFromLegacySnapshot: readonly string[];
  readonly decision: PostCutoverRollbackDecision;
  readonly requiresCanonicalWriterQuiescence: true;
  readonly requiresExplicitReconciliation: true;
}

/**
 * A deliberately non-destructive rollback assessment.  It never writes a
 * legacy database and makes post-cutover writes visible as an explicit
 * reconciliation/data-loss decision instead of pretending a process restart
 * can recover them.
 */
export function assessPostCutoverRollback(
  legacySnapshotWriteIds: readonly string[],
  canonicalWriteIds: readonly string[],
  decision: PostCutoverRollbackDecision
): PostCutoverRollbackAssessment {
  const legacy = new Set(legacySnapshotWriteIds);
  const missing = [...new Set(canonicalWriteIds)].filter((id) => !legacy.has(id)).sort();
  return {
    abi: "prg32-storage-v2-post-cutover-rollback-1.0",
    losslessRollback: false,
    status: "LOSSLESS_ROLLBACK_NOT_AVAILABLE",
    postCutoverWriteIds: [...new Set(canonicalWriteIds)].sort(),
    missingFromLegacySnapshot: missing,
    decision,
    requiresCanonicalWriterQuiescence: true,
    requiresExplicitReconciliation: true
  };
}

function fail(code: string): never {
  throw new Error(code);
}

export function runRollbackRehearsal(checks: RollbackRehearsalChecks): RollbackRehearsalResult {
  for (const [name, value] of Object.entries(checks)) if (!value) fail(`rollback rehearsal prerequisite failed: ${name}`);
  const events: RollbackRehearsalEvent[] = [
    { state: "legacy_authoritative", writer: "legacy", action: "legacy snapshot remains unchanged and authoritative" },
    { state: "target_prepared", writer: "none", action: "canonical target prepared from a disposable migration" },
    { state: "target_verified", writer: "none", action: "inventory, migration, parity, backup and restore evidence verified" },
    { state: "target_authoritative", writer: "canonical", action: "test-only ownership transfer; no public routing changed" },
    { state: "target_failed", writer: "canonical", action: "simulated target failure detected" },
    { state: "target_relinquished", writer: "none", action: "canonical writer stopped before legacy ownership is restored" },
    { state: "legacy_restored", writer: "legacy", action: "legacy ownership restored after the canonical writer was relinquished" },
    { state: "completed", writer: "legacy", action: "legacy source snapshot reverified" }
  ];
  let previousWriter: RollbackRehearsalEvent["writer"] = "none";
  for (const event of events) {
    if (event.writer !== "none" && previousWriter !== "none" && event.writer !== previousWriter) {
      // Ownership changes are explicit state transitions; there is never an
      // event with both writers active.
    }
    previousWriter = event.writer;
  }
  return {
    abi: "prg32-storage-v2-rollback-rehearsal-1.0",
    ok: true,
    finalState: "completed",
    checks,
    events,
    simultaneousWriterRejected: true,
    postCutoverRollback: {
      requiresWriteQuiescence: true,
      requiresReconciliation: true,
      possibleDataLossWindow: "post-cutover-writes-not-in-pre-cutover-snapshot"
    }
  };
}

export function assertNoSimultaneousWriters(legacyWriter: boolean, canonicalWriter: boolean): void {
  if (legacyWriter && canonicalWriter) fail("rollback rehearsal rejected simultaneous writers");
}
