import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BackupError } from "../backup/format.js";
import type {
  CANONICAL_BACKUP_ABI,
  CanonicalRestoreFaultPoint,
} from "./backup-contracts.js";
import { canonicalJson } from "./backup-validation.js";

/** File used to persist the canonical restore state across process restarts. */
export const RESTORE_STATE_FILE = ".prg32-storage-v2-restore.json";

/** Durable state written while a canonical restore advances through its phases. */
export interface RestoreJournal {
  readonly abi: typeof CANONICAL_BACKUP_ABI;
  readonly operation_id: string;
  readonly backup_id: string;
  readonly archive_sha256: string;
  readonly state:
    | "preparing"
    | "restoring_database"
    | "restoring_objects"
    | "restoring_staging"
    | "restoring_journals"
    | "verifying"
    | "completed"
    | "recovery_required"
    | "failed";
  readonly updated_at: string;
  readonly error_code?: string;
}

/** Writes a file and its parent directory durably using a temporary sibling. */
export function writeDurable(filePath: string, value: string): void {
  const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
  const fd = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeSync(fd, value, undefined, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
  const directory = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

/** Persists one canonical restore journal state. */
export function writeRestoreState(root: string, state: RestoreJournal): void {
  const filePath = path.join(root, RESTORE_STATE_FILE);
  writeDurable(filePath, `${canonicalJson(state)}\n`);
}

/** Copies extracted restore data without allowing symlinks or overwrites. */
export function copyExtractedData(
  extractedData: string,
  targetRoot: string,
  fault?: (point: CanonicalRestoreFaultPoint) => void,
): void {
  if (!fs.existsSync(extractedData)) return;
  const walk = (directory: string): void => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, item.name);
      const relative = path.relative(extractedData, source);
      const destination = path.join(targetRoot, relative);
      if (item.isSymbolicLink()) {
        throw new BackupError(
          "canonical restore rejects symlinks",
          "canonical_restore_symlink_rejected",
        );
      }
      if (item.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        walk(source);
        continue;
      }
      if (!item.isFile() || fs.existsSync(destination)) {
        throw new BackupError(
          "canonical restore refuses an overwrite",
          "canonical_restore_conflict",
        );
      }
      fs.mkdirSync(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
      if (relative.startsWith(`storage${path.sep}staging${path.sep}`)) {
        fault?.("during-staging-restoration");
      }
      if (relative.startsWith(`journal${path.sep}`)) {
        fault?.("during-journal-restoration");
      } else {
        fault?.("during-object-extraction");
      }
    }
  };
  walk(extractedData);
}

/** Promotes an extracted database while supporting cross-filesystem targets. */
export function promoteRestoredDatabase(
  source: string,
  destination: string,
): void {
  try {
    fs.renameSync(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  fs.unlinkSync(source);
}

/** Returns the durable restore journal path for a storage root. */
export function restoreStatePath(root: string): string {
  return path.join(root, RESTORE_STATE_FILE);
}
