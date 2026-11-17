import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class CanonicalWriterLockError extends Error {
  readonly code: "canonical_writer_lock_held" | "canonical_writer_lock_corrupt";

  constructor(message: string, code: CanonicalWriterLockError["code"]) {
    super(message);
    this.name = "CanonicalWriterLockError";
    this.code = code;
  }
}

/** A process-held filesystem lease. Dead-process leases may be reclaimed; live or malformed leases fail closed. */
export class CanonicalWriterLease {
  private readonly lockPath: string;
  private readonly token = crypto.randomUUID();
  private descriptor: number | undefined;

  constructor(root: string) {
    this.lockPath = path.join(root, "canonical-writer.lock");
    this.acquire();
  }

  private acquire(): void {
    const record = { pid: process.pid, token: this.token, createdAt: new Date().toISOString() };
    try {
      this.descriptor = fs.openSync(this.lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
      fs.writeSync(this.descriptor, JSON.stringify(record));
      fs.fsyncSync(this.descriptor);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let existing: { pid?: number; createdAt?: string };
    try { existing = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as typeof existing; }
    catch { throw new CanonicalWriterLockError("canonical writer lock is malformed", "canonical_writer_lock_corrupt"); }
    if (!Number.isSafeInteger(existing.pid) || typeof existing.createdAt !== "string") {
      throw new CanonicalWriterLockError("canonical writer lock is malformed", "canonical_writer_lock_corrupt");
    }
    let alive = true;
    try { process.kill(existing.pid as number, 0); } catch { alive = false; }
    if (alive) throw new CanonicalWriterLockError("canonical writer is already active", "canonical_writer_lock_held");
    const stalePath = `${this.lockPath}.stale-${crypto.randomUUID()}`;
    try { fs.renameSync(this.lockPath, stalePath); fs.unlinkSync(stalePath); }
    catch { throw new CanonicalWriterLockError("canonical writer lock could not be reclaimed", "canonical_writer_lock_held"); }
    this.acquire();
  }

  close(): void {
    if (this.descriptor === undefined) return;
    try { fs.closeSync(this.descriptor); } finally {
      this.descriptor = undefined;
      try {
        const current = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as { token?: string };
        if (current.token === this.token) fs.unlinkSync(this.lockPath);
      } catch { /* a crashed or externally altered lock remains fail-closed */ }
    }
  }
}
