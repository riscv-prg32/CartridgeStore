import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { ReviewError, type ReviewErrorCode } from "../review/errors.js";
import { expectedStorageKey, MAX_OBJECT_BYTES } from "./objects.js";
import { sha256 } from "./workflow-codecs.js";

/** Planned object identity used by canonical publication promotion. */
export interface CanonicalObjectPlan {
  readonly objectId: string;
  readonly objectKind: "artifact" | "media";
  readonly targetRole: "artifact" | "icon" | "screenshot";
  readonly architecture: "esp32c6" | "qemu";
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly sourceStagingKey: string;
  readonly artifactId: string;
  readonly mediaId: string | null;
  readonly targetStorageKey?: string;
}

interface PromotionOptions {
  readonly root: string;
  readonly objectTempRoot: string;
  readonly database: Database.Database;
  readonly fail: (
    message: string,
    code?: ReviewErrorCode,
    status?: number,
  ) => never;
}

function inside(root: string, relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some(
      (part) => !part || part === "." || part === "..",
    ) ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new ReviewError(
      "canonical staging path is unsafe",
      "review_operation_failed",
      500,
    );
  }
  const candidate = path.resolve(root, normalized);
  const rootPath = path.resolve(root);
  if (!candidate.startsWith(`${rootPath}${path.sep}`)) {
    throw new ReviewError(
      "canonical staging path escapes the disposable root",
      "review_operation_failed",
      500,
    );
  }
  let current = rootPath;
  for (const component of path
    .relative(rootPath, candidate)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new ReviewError(
        "canonical staging path contains a symlink",
        "review_operation_failed",
        500,
      );
    }
  }
  return candidate;
}

/** Verifies a promoted object against its expected filesystem identity. */
export function verifyCanonicalObject(
  root: string,
  item: CanonicalObjectPlan,
): boolean {
  const target = inside(
    root,
    item.targetStorageKey ??
      expectedStorageKey(item.objectKind, item.objectId, item.mediaType),
  );
  if (!fs.existsSync(target)) return false;
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== item.sizeBytes) {
    return false;
  }
  return sha256(fs.readFileSync(target)) === item.sha256;
}

/** Promotes one staged object and records its available state transactionally. */
export function promoteCanonicalObject(
  options: PromotionOptions,
  item: CanonicalObjectPlan,
  bytes: Buffer,
): void {
  const { database, fail, objectTempRoot, root } = options;
  if (
    bytes.byteLength > MAX_OBJECT_BYTES ||
    sha256(bytes) !== item.sha256 ||
    bytes.byteLength !== item.sizeBytes
  ) {
    fail("publication object integrity failed", "review_operation_failed", 500);
  }
  const targetRelative = expectedStorageKey(
    item.objectKind,
    item.objectId,
    item.mediaType,
  );
  const target = inside(root, targetRelative);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) {
    if (!verifyCanonicalObject(root, { ...item, targetStorageKey: targetRelative })) {
      fail(
        "publication target conflicts with an existing object",
        "review_operation_failed",
        500,
      );
    }
    database
      .prepare(
        "UPDATE storage_objects SET state = 'available' " +
          "WHERE object_id = ? AND state = 'staged'",
      )
      .run(item.objectId);
    return;
  }
  const temporary = path.join(
    objectTempRoot,
    `${item.objectId}.${crypto.randomUUID()}.tmp`,
  );
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    fs.unlinkSync(temporary);
  } catch {
    // The completed link remains verifiable.
  }
  const directory = fs.openSync(parent, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
  if (!verifyCanonicalObject(root, { ...item, targetStorageKey: targetRelative })) {
    fail("promoted object verification failed", "review_operation_failed", 500);
  }
  database
    .prepare(
      "UPDATE storage_objects SET state = 'available' " +
        "WHERE object_id = ? AND state = 'staged'",
    )
    .run(item.objectId);
}
