import fs from "node:fs";
import crypto from "node:crypto";

import type { ResolvedStorageObject } from "./types.js";

/** Result returned by immutable storage object verification. */
export interface StorageObjectVerification {
  readonly ok: boolean;
  readonly code:
    | "ok"
    | "missing"
    | "symlink"
    | "not_regular_file"
    | "size_mismatch"
    | "hash_mismatch"
    | "invalid_storage_key";
  readonly message: string;
  readonly actualSizeBytes?: number;
  readonly actualSha256?: string;
}

function verificationCode(error: unknown): StorageObjectVerification["code"] {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "object_invalid";
  return code === "object_file_missing"
    ? "missing"
    : code === "object_symlink_rejected"
      ? "symlink"
      : code === "object_not_regular_file"
        ? "not_regular_file"
        : code === "object_size_mismatch"
          ? "size_mismatch"
          : code === "object_storage_key_invalid"
            ? "invalid_storage_key"
            : "missing";
}

/** Verifies an object by resolving its file and comparing size and SHA-256. */
export function verifyStorageObject(
  objectId: string,
  resolve: (objectId: string) => ResolvedStorageObject,
): StorageObjectVerification {
  let resolved: ResolvedStorageObject;
  try {
    resolved = resolve(objectId);
  } catch (error) {
    return {
      ok: false,
      code: verificationCode(error),
      message:
        error instanceof Error
          ? error.message
          : "storage object is invalid",
    };
  }
  const hash = crypto.createHash("sha256");
  let total = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = fs.readSync(
        resolved.fileDescriptor,
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (count === 0) break;
      total += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(resolved.fileDescriptor);
  }
  const actualSha256 = hash.digest("hex");
  if (total !== resolved.record.sizeBytes) {
    return {
      ok: false,
      code: "size_mismatch",
      message: "storage object size does not match metadata",
      actualSizeBytes: total,
      actualSha256,
    };
  }
  if (actualSha256 !== resolved.record.sha256) {
    return {
      ok: false,
      code: "hash_mismatch",
      message: "storage object hash does not match metadata",
      actualSizeBytes: total,
      actualSha256,
    };
  }
  return {
    ok: true,
    code: "ok",
    message: "storage object is intact",
    actualSizeBytes: total,
    actualSha256,
  };
}
