import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertInside, BackupError } from "./format.js";

const LOCK_FILE = "publication.lock";

/** Return an ISO timestamp for backup journals and lock records. */
export function now(): string {
  return new Date().toISOString();
}

/** Calculate the stable SHA-256 digest used by backup inventories. */
export function sha256(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Write a small operational file atomically with restrictive permissions. */
export function writeAtomic(filePath: string, value: Uint8Array): void {
  const temporary =
    filePath + ".tmp-" + process.pid + "-" + crypto.randomUUID();
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
}

/** Encode a journal or manifest object using the existing JSON format. */
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Read and validate a recovery journal JSON document. */
export function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new BackupError(
      "backup recovery journal is invalid",
      "backup_recovery_journal_invalid",
      500,
      { cause: error },
    );
  }
}

/** Resolve a relative backup path while keeping it inside the store root. */
export function safeDirectory(root: string, relative: string): string {
  return assertInside(root, path.join(root, relative));
}

/** Create or validate a private backup directory under the store root. */
export function ensureDirectory(root: string, relative: string): string {
  const candidate = safeDirectory(root, relative);
  if (fs.existsSync(candidate)) {
    const stats = fs.lstatSync(candidate);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new BackupError(
        "backup directory is unsafe",
        "backup_unsafe_path",
        500,
      );
    }
  } else {
    fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  }
  return candidate;
}

/** Handle for the process-wide backup maintenance lock. */
export interface BackupLock {
  readonly token: string;
  readonly path: string;
}

/** Acquire the existing exclusive backup maintenance lock. */
export function acquireLock(root: string): BackupLock {
  const lockPath = path.join(root, LOCK_FILE);
  const token = crypto.randomUUID();
  const record = { pid: process.pid, token, createdAt: now() };
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { token, path: lockPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new BackupError(
        "backup maintenance lock failed",
        "backup_lock_failed",
        500,
        { cause: error },
      );
    }
    throw new BackupError("backup operation is busy", "backup_busy", 409);
  }
}

/** Release the lock only when it still belongs to this operation. */
export function releaseLock(lock: BackupLock): void {
  try {
    const current = JSON.parse(fs.readFileSync(lock.path, "utf8")) as {
      token?: string;
    };
    if (current.token === lock.token) fs.unlinkSync(lock.path);
  } catch {
    // Recovery remains visible through the journal.
  }
}
