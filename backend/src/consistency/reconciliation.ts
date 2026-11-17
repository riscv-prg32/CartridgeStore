import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { safeGameId, safeVersion } from "../catalog/catalog.js";
import {
  object,
  parseArchitectures,
  parseObjectJson,
  isoNow,
  statusForFindings,
} from "./publication-codecs.js";
import {
  assertInside,
  assertNoSymlinkComponents,
  assertSafeRelative,
  fileExists,
  listDirectories,
  sha256File,
} from "./publication-files.js";
import type {
  PublicationOperation,
  ReconciliationClassification,
  ReconciliationFinding,
  ReconciliationReport,
} from "./publication-contracts.js";
import {
  scanPublishedCartridges,
  scanTemporaryPublicationWorkspaces,
} from "./reconciliation-files.js";
import { scanPublicationOperations } from "./reconciliation-operations.js";

const PENDING_ROOT = "pending";
const CARTRIDGE_ROOT = "cartridges";

interface SubmissionRow {
  readonly id: number;
  readonly game_id: string;
  readonly version: string;
  readonly status: string;
  readonly pending_dir: string;
  readonly metadata_json: string;
  readonly architectures_json: string;
}

interface StoredArchitecture {
  readonly architecture?: unknown;
  readonly stored?: unknown;
  readonly file?: unknown;
}

interface ReconciliationOptions {
  readonly root: string;
  readonly database: Database.Database;
  readonly loadIndex: () => Record<string, unknown>;
  readonly readOperation: (operationId: string) => PublicationOperation;
}

/** Scans publication state without mutating the catalog or its database. */
export function reconcilePublication(
  options: ReconciliationOptions,
): ReconciliationReport {
  const { root, database } = options;
  const findings: ReconciliationFinding[] = [];
  const add = (finding: ReconciliationFinding) => findings.push(finding);
  let rows: SubmissionRow[] = [];
  try {
    rows = database
      .prepare(
        "SELECT id, game_id, version, status, pending_dir, " +
          "metadata_json, architectures_json FROM cartridge_submissions " +
          "ORDER BY id",
      )
      .all() as SubmissionRow[];
  } catch {
    add({
      code: "SUBMISSION_TABLE_UNAVAILABLE",
      classification: "CORRUPT",
      message: "cartridge_submissions cannot be inspected",
    });
  }
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const pendingKeys = new Set(
    rows
      .filter((row) => row.status === "pending")
      .map((row) => `${row.game_id}/${row.version}`),
  );
  const verifiedExpectations: Array<{
    readonly row: SubmissionRow;
    readonly gameId: string;
    readonly version: string;
    readonly architecture: string;
  }> = [];
  const safeDirectoryExists = (relative: string): boolean => {
    try {
      const candidate = assertInside(
        root,
        path.join(root, assertSafeRelative(relative, "pending directory")),
        "pending directory",
      );
      assertNoSymlinkComponents(root, candidate);
      return fs.existsSync(candidate) && fs.lstatSync(candidate).isDirectory();
    } catch (error) {
      add({
        code: "UNSAFE_PUBLICATION_PATH",
        classification: "CORRUPT",
        message: error instanceof Error
          ? error.message
          : "publication path is unsafe",
        path: relative,
      });
      return false;
    }
  };
  const safeFileExists = (relative: string): boolean => {
    try {
      return Boolean(relative) && fileExists(root, relative);
    } catch (error) {
      add({
        code: "UNSAFE_PUBLICATION_PATH",
        classification: "CORRUPT",
        message: error instanceof Error
          ? error.message
          : "publication path is unsafe",
        path: relative,
      });
      return false;
    }
  };
  for (const row of rows) {
    const pendingDirectory = row.pending_dir || `${PENDING_ROOT}/${row.id}`;
    const hasPendingDirectory = safeDirectoryExists(pendingDirectory);
    if (row.status === "pending" && !hasPendingDirectory) {
      add({
        code: "PENDING_ROW_WITHOUT_DIRECTORY",
        classification: "RECOVERABLE",
        message: "pending database row has no pending directory",
        submissionId: row.id,
        path: pendingDirectory,
      });
    }
    if (row.status !== "pending" && hasPendingDirectory) {
      add({
        code: "VERIFIED_SUBMISSION_WITH_PENDING_ARTIFACTS",
        classification: "RECOVERABLE",
        message: "non-pending submission still has pending artifacts",
        submissionId: row.id,
        path: pendingDirectory,
      });
    }
    if (row.status === "pending") {
      let architectures: StoredArchitecture[] = [];
      try {
        architectures = parseArchitectures(row.architectures_json);
      } catch (error) {
        add({
          code: "SUBMISSION_METADATA_CORRUPT",
          classification: "CORRUPT",
          message: error instanceof Error
            ? error.message
            : "submission architectures are malformed",
          submissionId: row.id,
        });
      }
      for (const item of architectures) {
        const stored = typeof item.stored === "string" ? item.stored : "";
        if (!stored || !safeFileExists(stored)) {
          add({
            code: "MISSING_PENDING_VARIANT",
            classification: "RECOVERABLE",
            message: "pending row references a missing architecture file",
            submissionId: row.id,
            path: stored,
          });
        }
      }
    }
    if (row.status === "verified") {
      let gameId = row.game_id;
      let version = row.version;
      try {
        const metadata = parseObjectJson(row.metadata_json, "submission metadata");
        gameId = safeGameId(
          typeof metadata.id === "string" ? metadata.id : row.game_id,
        );
        version = safeVersion(
          typeof metadata.version === "string"
            ? metadata.version
            : row.version,
        );
      } catch (error) {
        add({
          code: "SUBMISSION_METADATA_CORRUPT",
          classification: "CORRUPT",
          message: error instanceof Error
            ? error.message
            : "submission metadata is malformed",
          submissionId: row.id,
        });
      }
      try {
        for (const item of parseArchitectures(row.architectures_json)) {
          if (typeof item.architecture === "string" && item.architecture) {
            verifiedExpectations.push({
              row,
              gameId,
              version,
              architecture: item.architecture,
            });
          }
        }
      } catch (error) {
        add({
          code: "SUBMISSION_METADATA_CORRUPT",
          classification: "CORRUPT",
          message: error instanceof Error
            ? error.message
            : "submission architectures are malformed",
          submissionId: row.id,
        });
      }
    }
  }
  let pendingDirectories: string[] = [];
  try {
    pendingDirectories = listDirectories(root, PENDING_ROOT);
  } catch (error) {
    add({
      code: "PENDING_SCAN_FAILED",
      classification: "CORRUPT",
      message: error instanceof Error
        ? error.message
        : "pending directory cannot be scanned",
    });
  }
  for (const directory of pendingDirectories) {
    const id = Number(directory);
    if (!Number.isSafeInteger(id) || !rowById.has(id)) {
      add({
        code: "ORPHAN_PENDING_DIRECTORY",
        classification: "AMBIGUOUS",
        message: "pending directory has no database row",
        path: `${PENDING_ROOT}/${directory}`,
      });
    }
  }
  const loaded = (() => {
    try {
      return options.loadIndex();
    } catch (error) {
      add({
        code: "INDEX_CORRUPT",
        classification: "CORRUPT",
        message: error instanceof Error
          ? error.message
          : "catalog index is corrupt",
        path: "index.json",
      });
      return null;
    }
  })();
  const indexedFiles = new Set<string>();
  const indexedKeys = new Set<string>();
  if (loaded) {
    try {
      const games = object(loaded.games, "catalog index games is malformed");
      for (const [gameId, game] of Object.entries(games)) {
        const gameRecord = object(game, "catalog game is malformed");
        const versions = object(
          gameRecord.versions,
          "catalog versions are malformed",
        );
        for (const [versionId, version] of Object.entries(versions)) {
          indexedKeys.add(`${gameId}/${versionId}`);
          const versionRecord = object(version, "catalog version is malformed");
          const architectures = object(
            versionRecord.architectures,
            "catalog architectures are malformed",
          );
          for (const variant of Object.values(architectures)) {
            const record = object(variant, "catalog variant is malformed");
            const filename = typeof record.filename === "string"
              ? record.filename
              : "";
            if (!filename || !safeFileExists(filename)) {
              add({
                code: "INDEX_ENTRY_MISSING_FILE",
                classification: "CORRUPT",
                message: "index entry points to a missing file",
                path: filename,
              });
            } else {
              indexedFiles.add(filename);
              if (
                typeof record.sha256 === "string" &&
                sha256File(
                  assertInside(
                    root,
                    path.join(root, filename),
                    "catalog file",
                  ),
                ) !== record.sha256
              ) {
                add({
                  code: "PUBLISHED_HASH_MISMATCH",
                  classification: "CORRUPT",
                  message: "published file hash differs from index",
                  path: filename,
                });
              }
            }
          }
        }
      }
      for (const expectation of verifiedExpectations) {
        const target = [
          CARTRIDGE_ROOT,
          expectation.gameId,
          expectation.version,
          `${expectation.architecture}.prg32`,
        ].join("/");
        if (!indexedFiles.has(target)) {
          add({
            code: "SUBMISSION_MARKED_VERIFIED_WITHOUT_PUBLICATION",
            classification: "AMBIGUOUS",
            message: "verified submission architecture is absent from the catalog index",
            submissionId: expectation.row.id,
            path: target,
          });
        }
        if (!safeFileExists(target)) {
          add({
            code: "MISSING_ARCHITECTURE_VARIANT",
            classification: "CORRUPT",
            message: "verified submission architecture file is missing",
            submissionId: expectation.row.id,
            path: target,
          });
        }
      }
      for (const key of pendingKeys) {
        if (indexedKeys.has(key)) {
          add({
            code: "PUBLISHED_ARTIFACT_PENDING_SUBMISSION",
            classification: "RECOVERABLE",
            message: "catalog index contains an artifact whose submission is still pending",
            path: key,
          });
        }
      }
      scanPublishedCartridges(root, indexedFiles, { add });
    } catch (error) {
      add({
        code: "INDEX_SCHEMA_CORRUPT",
        classification: "CORRUPT",
        message: error instanceof Error
          ? error.message
          : "catalog index structure is malformed",
        path: "index.json",
      });
    }
  }
  const { operations, intentionallyDeletedTargets } = scanPublicationOperations({
    root,
    readOperation: options.readOperation,
    add,
  });
  for (let index = findings.length - 1; index >= 0; index -= 1) {
    const finding = findings[index];
    if (
      finding &&
      (finding.code === "SUBMISSION_MARKED_VERIFIED_WITHOUT_PUBLICATION" ||
        finding.code === "MISSING_ARCHITECTURE_VARIANT") &&
      finding.path &&
      intentionallyDeletedTargets.has(finding.path)
    ) {
      findings.splice(index, 1);
    }
  }
  const targetOwners = new Map<string, PublicationOperation[]>();
  for (const operation of operations) {
    if (![
      "COMPLETED",
      "COMPENSATED",
      "FAILED",
    ].includes(operation.state)) {
      const recovery: Exclude<ReconciliationClassification, "CONSISTENT"> =
        operation.state === "RECOVERY_REQUIRED" ||
        operation.state === "COMPENSATING"
          ? "AMBIGUOUS"
          : "RECOVERABLE";
      add({
        code: operation.state === "COMPENSATING"
          ? "INTERRUPTED_COMPENSATION"
          : "INCOMPLETE_PUBLICATION",
        classification: recovery,
        message: `publication operation is ${operation.state}`,
        operationId: operation.operationId,
        submissionId: operation.submissionId,
      });
    }
    for (const variant of operation.variants) {
      const owners = targetOwners.get(variant.targetRelative) ?? [];
      owners.push(operation);
      targetOwners.set(variant.targetRelative, owners);
    }
    if (
      operation.state === "VERIFIED" &&
      !safeFileExists(operation.indexStagedRelative)
    ) {
      add({
        code: "VERIFIED_OPERATION_MISSING_INDEX_STAGE",
        classification: "AMBIGUOUS",
        message: "verified operation has no staged index",
        operationId: operation.operationId,
      });
    }
  }
  for (const [target, owners] of targetOwners) {
    if (
      owners.length > 1 &&
      owners.some(
        (operation) =>
          !["COMPLETED", "COMPENSATED", "FAILED"].includes(
            operation.state,
          ),
      )
    ) {
      add({
        code: "CONFLICTING_PUBLICATION_RECORDS",
        classification: "AMBIGUOUS",
        message: "multiple operations target the same published artifact",
        path: target,
        details: {
          operation_ids: owners.map((operation) => operation.operationId),
        },
      });
    }
  }
  const recoverablePublicationKeys = new Set(
    operations
      .filter(
        (operation) =>
          !["COMPLETED", "COMPENSATED", "FAILED"].includes(operation.state),
      )
      .map((operation) => `${operation.gameId}/${operation.version}`),
  );
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    if (
      finding?.code === "PUBLISHED_ARTIFACT_PENDING_SUBMISSION" &&
      finding.path &&
      !recoverablePublicationKeys.has(finding.path)
    ) {
      findings[index] = {
        ...finding,
        classification: "AMBIGUOUS",
        message:
          "catalog index contains an artifact whose pending submission " +
          "has no recoverable publication operation",
      };
    }
  }
  scanTemporaryPublicationWorkspaces(root, { add });
  return {
    status: statusForFindings(findings),
    checkedAt: isoNow(),
    root,
    findings,
    counts: Object.fromEntries(
      findings.reduce(
        (map, finding) =>
          map.set(finding.code, (map.get(finding.code) ?? 0) + 1),
        new Map<string, number>(),
      ),
    ),
  };
}
