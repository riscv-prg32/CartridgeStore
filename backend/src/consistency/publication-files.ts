import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PublicationConsistencyError } from "./errors.js";

const LOCK_MIN_AGE_MS = 1000;

function fail(message: string, code = "publication_consistency_failed", details?: unknown): never {
  throw new PublicationConsistencyError(message, code, details);
}

export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function readBounded(filePath: string, limit: number, code: string): Buffer {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.size > limit) fail("file exceeds the reconciliation limit", code, { path: filePath });
  return fs.readFileSync(filePath);
}

export function assertSafeRelative(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(normalized)) {
    fail(`${label} is unsafe`, "unsafe_publication_path");
  }
  return normalized;
}

export function assertInside(root: string, candidate: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail(`${label} escapes disposable root`, "unsafe_publication_path");
  return resolved;
}

export function assertNoSymlinkComponents(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("publication path escapes disposable root", "unsafe_publication_path");
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("publication path contains a symlink", "unsafe_publication_path");
  }
}

export function ensureDirectory(root: string, relative: string): string {
  const candidate = assertInside(root, path.join(root, relative), "directory");
  assertNoSymlinkComponents(root, candidate);
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(root, candidate);
  return candidate;
}

export function writeAtomic(root: string, relative: string, data: Uint8Array): void {
  const safeRelative = assertSafeRelative(relative, "atomic file");
  const target = assertInside(root, path.join(root, safeRelative), "atomic file");
  const parent = path.dirname(target);
  ensureDirectory(root, path.relative(root, parent));
  assertNoSymlinkComponents(root, target);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeSync(fd, Buffer.from(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
  try {
    const directoryFd = fs.openSync(parent, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch {
    // Directory fsync is not available on every supported development host.
  }
}

export function readJsonFile(root: string, relative: string, limit: number, code: string): unknown {
  const safeRelative = assertSafeRelative(relative, "journal path");
  const target = assertInside(root, path.join(root, safeRelative), "journal path");
  assertNoSymlinkComponents(root, target);
  try {
    return JSON.parse(readBounded(target, limit, code).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof PublicationConsistencyError) throw error;
    fail("journal or index JSON is malformed", code);
  }
}

export function listDirectories(root: string, relative: string): string[] {
  const directory = assertInside(root, path.join(root, relative), "scan directory");
  if (!fs.existsSync(directory)) return [];
  assertNoSymlinkComponents(root, directory);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > 4096) fail("directory scan exceeds the reconciliation limit", "scan_limit");
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
}

export function fileExists(root: string, relative: string): boolean {
  const candidate = assertInside(root, path.join(root, assertSafeRelative(relative, "file path")), "file path");
  if (!fs.existsSync(candidate)) return false;
  assertNoSymlinkComponents(root, candidate);
  return fs.lstatSync(candidate).isFile();
}

export function withPublicationLock<T>(lockPath: string, callback: () => T): T {
  const token = crypto.randomUUID();
  const record = { pid: process.pid, token, createdAt: new Date().toISOString() };
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try { fs.writeSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: { readonly pid: number; readonly token: string; readonly createdAt: string };
    try { existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as typeof existing; } catch { fail("publication lock is malformed", "publication_lock_ambiguous"); }
    const age = Date.now() - Date.parse(existing.createdAt);
    let alive = true;
    try { process.kill(existing.pid, 0); } catch { alive = false; }
    if (alive || !Number.isFinite(age) || age < LOCK_MIN_AGE_MS) fail("publication lock is held", "publication_lock_held", existing);
    const stale = `${lockPath}.stale-${crypto.randomUUID()}`;
    fs.renameSync(lockPath, stale);
    try { fs.unlinkSync(stale); } catch { /* preserve a stale lock if cleanup is denied */ }
    return withPublicationLock(lockPath, callback);
  }
  try { return callback(); } finally {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { readonly token?: string };
      if (current.token === token) fs.unlinkSync(lockPath);
    } catch { /* a crash or external change is reconciled explicitly */ }
  }
}
