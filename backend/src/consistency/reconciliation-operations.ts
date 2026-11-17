import type {
  PublicationOperation,
  ReconciliationFinding,
} from "./publication-contracts.js";
import { listDirectories } from "./publication-files.js";

const JOURNAL_ROOT = "publication-operations";

/** Input required to inspect journaled publication operations. */
export interface ReconciliationOperationScanOptions {
  readonly root: string;
  readonly readOperation: (operationId: string) => PublicationOperation;
  readonly add: (finding: ReconciliationFinding) => void;
}

/** Journal operations and completed delete targets found during reconciliation. */
export interface ReconciliationOperationScan {
  readonly operations: readonly PublicationOperation[];
  readonly intentionallyDeletedTargets: ReadonlySet<string>;
}

/** Reads publication journals without mutating operation state. */
export function scanPublicationOperations(
  options: ReconciliationOperationScanOptions,
): ReconciliationOperationScan {
  const operations: PublicationOperation[] = [];
  try {
    for (const operationId of listDirectories(options.root, JOURNAL_ROOT)) {
      try {
        operations.push(options.readOperation(operationId));
      } catch (error) {
        options.add({
          code: "JOURNAL_CORRUPT",
          classification: "CORRUPT",
          message:
            error instanceof Error
              ? error.message
              : "publication journal is corrupt",
          operationId,
        });
      }
    }
  } catch (error) {
    options.add({
      code: "JOURNAL_SCAN_FAILED",
      classification: "CORRUPT",
      message:
        error instanceof Error
          ? error.message
          : "publication journal cannot be scanned",
    });
  }
  const intentionallyDeletedTargets = new Set(
    operations
      .filter(
        (operation) =>
          operation.operationKind === "catalog" &&
          operation.catalogAction === "delete" &&
          operation.state === "COMPLETED",
      )
      .flatMap((operation) =>
        operation.variants.map((variant) => variant.targetRelative),
      ),
  );
  return { operations, intentionallyDeletedTargets };
}
