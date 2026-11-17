import fs from "node:fs";
import path from "node:path";

import { fail } from "./publication-codecs.js";
import { assertInside } from "./publication-files.js";
import type { ReconciliationFinding } from "./publication-contracts.js";

const CARTRIDGE_ROOT = "cartridges";
const STAGING_ROOT = "publication-staging";
const JOURNAL_ROOT = "publication-operations";
const MAX_SCAN_ENTRIES = 4096;

interface FindingSink {
  readonly add: (finding: ReconciliationFinding) => void;
}

/** Scans published cartridge files that are not represented by the index. */
export function scanPublishedCartridges(
  root: string,
  indexedFiles: ReadonlySet<string>,
  sink: FindingSink,
): void {
  const cartridges = assertInside(
    root,
    path.join(root, CARTRIDGE_ROOT),
    "cartridge directory",
  );
  if (!fs.existsSync(cartridges)) return;
  const walk = (directory: string, relative: string, depth: number): void => {
    if (depth > 4) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length > MAX_SCAN_ENTRIES) {
      fail(
        "cartridge scan exceeds the reconciliation limit",
        "scan_limit",
      );
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        sink.add({
          code: "UNSAFE_CARTRIDGE_OBJECT",
          classification: "CORRUPT",
          message: "published catalog contains a symlink",
          path: `${relative}/${entry.name}`,
        });
      } else if (entry.isDirectory()) {
        walk(
          path.join(directory, entry.name),
          `${relative}/${entry.name}`,
          depth + 1,
        );
      } else if (entry.isFile() && entry.name.endsWith(".prg32")) {
        const publishedPath = `${relative}/${entry.name}`;
        if (!indexedFiles.has(publishedPath)) {
          sink.add({
            code: "PUBLISHED_FILE_MISSING_FROM_INDEX",
            classification: "AMBIGUOUS",
            message: "published cartridge is not referenced by index",
            path: publishedPath,
          });
        }
      }
    }
  };
  walk(cartridges, CARTRIDGE_ROOT, 0);
}

/** Scans publication workspaces for symlinks and stale temporary files. */
export function scanTemporaryPublicationWorkspaces(
  root: string,
  sink: FindingSink,
): void {
  for (const temporaryRoot of [STAGING_ROOT, JOURNAL_ROOT]) {
    try {
      const directory = assertInside(
        root,
        path.join(root, temporaryRoot),
        "temporary scan",
      );
      if (!fs.existsSync(directory)) continue;
      const scan = (current: string, relative: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const next = path.join(current, entry.name);
          const nextRelative = `${relative}/${entry.name}`;
          if (entry.isSymbolicLink()) {
            sink.add({
              code: "UNSAFE_PUBLICATION_OBJECT",
              classification: "CORRUPT",
              message: "publication workspace contains a symlink",
              path: nextRelative,
            });
          } else if (entry.isDirectory()) {
            scan(next, nextRelative);
          } else if (entry.name.includes(".tmp-")) {
            sink.add({
              code: "STALE_TEMPORARY_FILE",
              classification: "RECOVERABLE",
              message: "temporary publication file remains",
              path: nextRelative,
            });
          }
        }
      };
      scan(directory, temporaryRoot);
    } catch (error) {
      sink.add({
        code: "TEMPORARY_SCAN_FAILED",
        classification: "CORRUPT",
        message:
          error instanceof Error
            ? error.message
            : "publication temporary area cannot be scanned",
        path: temporaryRoot,
      });
    }
  }
}
