import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type {
  FaultPoint,
  PublicationOperation,
  PublicationState,
} from "./publication-contracts.js";
import { fail } from "./publication-codecs.js";
import {
  assertInside,
  ensureDirectory,
  sha256File,
} from "./publication-files.js";

const STAGING_ROOT = "publication-staging";

/** Dependencies required to compensate one publication operation. */
export interface PublicationCompensationOptions {
  readonly root: string;
  readonly database: Database.Database;
  readonly operation: PublicationOperation;
  readonly hit: (point: FaultPoint) => void;
  readonly transition: (
    operation: PublicationOperation,
    state: PublicationState,
  ) => PublicationOperation;
}

/** Compensates filesystem, index and submission state after an ambiguous publish. */
export function compensatePublicationOperation(
  options: PublicationCompensationOptions,
): PublicationOperation {
  const { root, database, hit, transition } = options;
  const operation = options.operation;
  if (
    operation.state === "COMPLETED" ||
    operation.state === "COMPENSATED"
  ) {
    return operation;
  }
  hit("before-compensation");
  let current = transition(operation, "COMPENSATING");
  for (const variant of current.variants) {
    const target = assertInside(
      root,
      path.join(root, variant.targetRelative),
      "published target",
    );
    if (
      current.operationKind === "catalog" &&
      current.catalogAction === "delete"
    ) {
      const currentHash = fs.existsSync(target) ? sha256File(target) : null;
      if (currentHash === variant.previousSha256) continue;
      if (currentHash !== null) {
        fail(
          "cannot compensate a changed published file",
          "recovery_ambiguous",
          variant,
        );
      }
      const backup = assertInside(
        root,
        path.join(root, variant.backupRelative),
        "publication backup",
      );
      if (
        !fs.existsSync(backup) ||
        sha256File(backup) !== variant.previousSha256
      ) {
        fail(
          "compensation backup is unavailable",
          "recovery_ambiguous",
          variant,
        );
      }
      ensureDirectory(root, path.dirname(path.relative(root, target)));
      fs.copyFileSync(backup, target, fs.constants.COPYFILE_EXCL);
      continue;
    }
    if (!fs.existsSync(target)) continue;
    const currentHash = sha256File(target);
    if (currentHash === variant.previousSha256) continue;
    if (currentHash !== variant.expectedSha256) {
      fail(
        "cannot compensate a changed published file",
        "recovery_ambiguous",
        variant,
      );
    }
    if (variant.previousSha256 === null) {
      fs.unlinkSync(target);
    } else {
      const backup = assertInside(
        root,
        path.join(root, variant.backupRelative),
        "publication backup",
      );
      if (
        !fs.existsSync(backup) ||
        sha256File(backup) !== variant.previousSha256
      ) {
        fail(
          "compensation backup is unavailable",
          "recovery_ambiguous",
          variant,
        );
      }
      fs.copyFileSync(backup, target);
    }
  }
  const indexPath = path.join(root, "index.json");
  if (fs.existsSync(indexPath)) {
    const currentHash = sha256File(indexPath);
    if (currentHash === current.expectedIndexSha256) {
      if (current.previousIndexSha256 === null) {
        fs.unlinkSync(indexPath);
      } else {
        const backup = assertInside(
          root,
          path.join(root, current.indexBackupRelative),
          "index backup",
        );
        if (
          !fs.existsSync(backup) ||
          sha256File(backup) !== current.previousIndexSha256
        ) {
          fail(
            "index compensation backup is unavailable",
            "recovery_ambiguous",
          );
        }
        fs.copyFileSync(backup, indexPath);
      }
    } else if (currentHash !== current.previousIndexSha256) {
      fail("cannot compensate a changed catalog index", "recovery_ambiguous");
    }
  }
  if (current.operationKind !== "catalog") {
    const row = database
      .prepare("SELECT status FROM cartridge_submissions WHERE id = ?")
      .get(current.submissionId) as { status?: string } | undefined;
    if (row?.status === "verified") {
      database
        .prepare(
          "UPDATE cartridge_submissions SET status = 'pending', " +
            "reviewed_by = '', reviewed_at = NULL WHERE id = ?",
        )
        .run(current.submissionId);
    }
  }
  fs.rmSync(
    assertInside(
      root,
      path.join(root, `${STAGING_ROOT}/${current.operationId}`),
      "staging directory",
    ),
    { recursive: true, force: true },
  );
  current = transition(current, "COMPENSATED");
  hit("after-compensation");
  return current;
}
