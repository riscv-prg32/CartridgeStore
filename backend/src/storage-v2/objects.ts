import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import {
  OBJECT_KINDS,
  type ObjectKind,
  type ResolvedStorageObject,
  type StorageObjectRecord,
  type StoragePaths
} from "./types.js";
import { verifyStorageObject } from "./object-verification.js";

export const CARTRIDGE_MEDIA_TYPE = "application/vnd.prg32.cartridge";
export const MAX_OBJECT_BYTES = 128 * 1024 * 1024;

const OBJECT_ID = /^obj_[a-f0-9-]{16,80}$/u;
const SAFE_STORAGE_KEY = /^storage\/objects\/(artifacts|media|site-assets)\/obj_[a-f0-9-]{16,80}\.(prg32|png|jpg|svg|bin)$/u;

export type ObjectFaultPoint =
  | "before-temporary-file"
  | "during-write"
  | "before-promotion"
  | "after-promotion"
  | "before-database-insert"
  | "after-database-insert";

export class StorageObjectError extends Error {
  readonly code: string;

  constructor(message: string, code = "storage_object_invalid", options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageObjectError";
    this.code = code;
  }
}

export interface StoreObjectOptions {
  readonly objectId?: string;
  readonly createdByOperationId?: string;
  readonly fault?: (point: ObjectFaultPoint) => void;
}

export interface StoreFileOptions extends StoreObjectOptions {
  readonly sourcePath: string;
}

export interface ObjectVerification {
  readonly ok: boolean;
  readonly code: "ok" | "missing" | "symlink" | "not_regular_file" | "size_mismatch" | "hash_mismatch" | "invalid_storage_key";
  readonly message: string;
  readonly actualSizeBytes?: number;
  readonly actualSha256?: string;
}

function objectFolder(kind: ObjectKind): string {
  if (kind === "artifact") return "artifacts";
  if (kind === "media") return "media";
  return "site-assets";
}

function extension(kind: ObjectKind, mediaType: string): string {
  if (kind === "artifact") {
    if (mediaType !== CARTRIDGE_MEDIA_TYPE) throw new StorageObjectError("artifact media type is invalid", "object_media_type_invalid");
    return "prg32";
  }
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "application/octet-stream": "bin"
  };
  const value = extensions[mediaType];
  if (!value) throw new StorageObjectError("media type is not allowed for this object kind", "object_media_type_invalid");
  return value;
}

function assertObjectKind(value: string): asserts value is ObjectKind {
  if (!OBJECT_KINDS.includes(value as ObjectKind)) throw new StorageObjectError("object kind is invalid", "object_kind_invalid");
}

function assertObjectId(value: string): void {
  if (!OBJECT_ID.test(value)) throw new StorageObjectError("object identifier is invalid", "object_id_invalid");
}

function generatedObjectId(): string {
  return `obj_${crypto.randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoSymlinkComponents(root: string, candidate: string): void {
  if (!contained(root, candidate)) throw new StorageObjectError("object path escapes object root", "object_path_unsafe");
  let current = root;
  for (const component of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new StorageObjectError("object path contains a symlink", "object_symlink_rejected");
    }
  }
}

export function expectedStorageKey(kind: ObjectKind, objectId: string, mediaType: string): string {
  assertObjectKind(kind);
  assertObjectId(objectId);
  return `storage/objects/${objectFolder(kind)}/${objectId}.${extension(kind, mediaType)}`;
}

function recordFromRow(row: Record<string, unknown>): StorageObjectRecord {
  const objectKind = String(row.object_kind);
  assertObjectKind(objectKind);
  return {
    objectId: String(row.object_id),
    objectKind,
    storageKey: String(row.storage_key),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
    mediaType: String(row.media_type),
    state: String(row.state) as StorageObjectRecord["state"],
    createdAt: String(row.created_at),
    retiredAt: typeof row.retired_at === "string" ? row.retired_at : null,
    createdByOperationId: typeof row.created_by_operation_id === "string" ? row.created_by_operation_id : null
  };
}

export class ObjectStore {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly paths: StoragePaths,
    private readonly maxObjectBytes = MAX_OBJECT_BYTES
  ) {}

  store(kind: ObjectKind, bytes: Uint8Array, mediaType: string, options: StoreObjectOptions = {}): StorageObjectRecord {
    assertObjectKind(kind);
    if (!(bytes instanceof Uint8Array)) throw new StorageObjectError("object bytes must be a byte array", "object_bytes_invalid");
    if (bytes.byteLength > this.maxObjectBytes) throw new StorageObjectError("object exceeds the configured size limit", "object_too_large");
    const objectId = options.objectId ?? generatedObjectId();
    assertObjectId(objectId);
    const storageKey = expectedStorageKey(kind, objectId, mediaType);
    if (!SAFE_STORAGE_KEY.test(storageKey)) throw new StorageObjectError("generated storage key is invalid", "object_storage_key_invalid");
    const finalPath = path.resolve(this.paths.root, storageKey);
    const temporaryPath = path.join(this.paths.objectTempRoot, `${objectId}.${crypto.randomUUID()}.tmp`);
    assertNoSymlinkComponents(this.paths.objectRoot, path.dirname(finalPath));
    if (fs.existsSync(finalPath)) throw new StorageObjectError("object destination already exists", "object_destination_exists");

    let descriptor: number | undefined;
    try {
      options.fault?.("before-temporary-file");
      descriptor = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      options.fault?.("during-write");
      const hash = crypto.createHash("sha256");
      hash.update(bytes);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      options.fault?.("before-promotion");
      if (fs.existsSync(finalPath)) throw new StorageObjectError("object destination already exists", "object_destination_exists");
      fs.linkSync(temporaryPath, finalPath);
      fs.unlinkSync(temporaryPath);
      const directoryDescriptor = fs.openSync(this.paths.objectRoot, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
      options.fault?.("after-promotion");
      const record: StorageObjectRecord = {
        objectId,
        objectKind: kind,
        storageKey,
        sha256: hash.digest("hex"),
        sizeBytes: bytes.byteLength,
        mediaType,
        state: "available",
        createdAt: now(),
        retiredAt: null,
        createdByOperationId: options.createdByOperationId ?? null
      };
      const insert = this.sqlite.transaction(() => {
        options.fault?.("before-database-insert");
        this.sqlite.prepare(
          `INSERT INTO storage_objects(object_id, object_kind, storage_key, sha256, size_bytes, media_type, state, created_at, created_by_operation_id)
           VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)`
        ).run(record.objectId, record.objectKind, record.storageKey, record.sha256, record.sizeBytes, record.mediaType, record.createdAt, record.createdByOperationId);
        options.fault?.("after-database-insert");
      });
      insert();
      return record;
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
      }
      if (error instanceof StorageObjectError) throw error;
      throw new StorageObjectError("immutable object storage failed", "object_write_failed", { cause: error });
    }
  }

  /**
   * Promote a regular source file without loading the complete file into
   * memory.  This is used by the disposable migration executor and shares
   * the same immutable promotion and database insertion boundary as store().
   */
  storeFile(kind: ObjectKind, mediaType: string, options: StoreFileOptions): StorageObjectRecord {
    assertObjectKind(kind);
    const sourceStats = fs.lstatSync(options.sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new StorageObjectError("source object must be a regular file", "object_source_invalid");
    }
    if (sourceStats.size > this.maxObjectBytes) {
      throw new StorageObjectError("object exceeds the configured size limit", "object_too_large");
    }
    const objectId = options.objectId ?? generatedObjectId();
    assertObjectId(objectId);
    const storageKey = expectedStorageKey(kind, objectId, mediaType);
    if (!SAFE_STORAGE_KEY.test(storageKey)) throw new StorageObjectError("generated storage key is invalid", "object_storage_key_invalid");
    const finalPath = path.resolve(this.paths.root, storageKey);
    const temporaryPath = path.join(this.paths.objectTempRoot, `${objectId}.${crypto.randomUUID()}.tmp`);
    assertNoSymlinkComponents(this.paths.objectRoot, path.dirname(finalPath));
    if (fs.existsSync(finalPath)) throw new StorageObjectError("object destination already exists", "object_destination_exists");

    let sourceDescriptor: number | undefined;
    let destinationDescriptor: number | undefined;
    try {
      options.fault?.("before-temporary-file");
      sourceDescriptor = fs.openSync(options.sourcePath, fs.constants.O_RDONLY);
      destinationDescriptor = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      options.fault?.("during-write");
      while (true) {
        const count = fs.readSync(sourceDescriptor, buffer, 0, buffer.byteLength, null);
        if (count === 0) break;
        total += count;
        if (total > this.maxObjectBytes) throw new StorageObjectError("object exceeds the configured size limit", "object_too_large");
        hash.update(buffer.subarray(0, count));
        fs.writeSync(destinationDescriptor, buffer, 0, count);
      }
      fs.fsyncSync(destinationDescriptor);
      fs.closeSync(destinationDescriptor);
      destinationDescriptor = undefined;
      fs.closeSync(sourceDescriptor);
      sourceDescriptor = undefined;
      options.fault?.("before-promotion");
      if (fs.existsSync(finalPath)) throw new StorageObjectError("object destination already exists", "object_destination_exists");
      fs.linkSync(temporaryPath, finalPath);
      fs.unlinkSync(temporaryPath);
      const directoryDescriptor = fs.openSync(this.paths.objectRoot, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
      options.fault?.("after-promotion");
      const record: StorageObjectRecord = {
        objectId,
        objectKind: kind,
        storageKey,
        sha256: hash.digest("hex"),
        sizeBytes: total,
        mediaType,
        state: "available",
        createdAt: now(),
        retiredAt: null,
        createdByOperationId: options.createdByOperationId ?? null
      };
      const insert = this.sqlite.transaction(() => {
        options.fault?.("before-database-insert");
        this.sqlite.prepare(
          `INSERT INTO storage_objects(object_id, object_kind, storage_key, sha256, size_bytes, media_type, state, created_at, created_by_operation_id)
           VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)`
        ).run(record.objectId, record.objectKind, record.storageKey, record.sha256, record.sizeBytes, record.mediaType, record.createdAt, record.createdByOperationId);
        options.fault?.("after-database-insert");
      });
      insert();
      return record;
    } catch (error) {
      if (sourceDescriptor !== undefined) {
        try { fs.closeSync(sourceDescriptor); } catch { /* preserve the original failure */ }
      }
      if (destinationDescriptor !== undefined) {
        try { fs.closeSync(destinationDescriptor); } catch { /* preserve the original failure */ }
      }
      try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* preserve the original failure */ }
      if (error instanceof StorageObjectError) throw error;
      throw new StorageObjectError("immutable object storage failed", "object_write_failed", { cause: error });
    }
  }

  metadata(objectId: string): StorageObjectRecord | null {
    assertObjectId(objectId);
    const row = this.sqlite.prepare("SELECT * FROM storage_objects WHERE object_id = ?").get(objectId) as Record<string, unknown> | undefined;
    return row ? recordFromRow(row) : null;
  }

  resolve(objectId: string, expectedKind?: ObjectKind): ResolvedStorageObject {
    const record = this.metadata(objectId);
    if (!record) throw new StorageObjectError("storage object was not found", "object_not_found");
    if (expectedKind && record.objectKind !== expectedKind) throw new StorageObjectError("storage object kind does not match relationship", "object_kind_mismatch");
    if (record.state !== "available") throw new StorageObjectError("storage object is not available", "object_not_available");
    let expectedKey: string;
    try { expectedKey = expectedStorageKey(record.objectKind, record.objectId, record.mediaType); } catch (error) {
      throw new StorageObjectError("storage object key cannot be validated", "object_storage_key_invalid", { cause: error });
    }
    if (record.storageKey !== expectedKey || !SAFE_STORAGE_KEY.test(record.storageKey)) {
      throw new StorageObjectError("storage object key is invalid", "object_storage_key_invalid");
    }
    const filePath = path.resolve(this.paths.root, record.storageKey);
    assertNoSymlinkComponents(this.paths.objectRoot, filePath);
    let stats: fs.Stats;
    try { stats = fs.lstatSync(filePath); } catch (error) {
      throw new StorageObjectError("storage object file is missing", "object_file_missing", { cause: error });
    }
    if (stats.isSymbolicLink()) throw new StorageObjectError("storage object file is a symlink", "object_symlink_rejected");
    if (!stats.isFile()) throw new StorageObjectError("storage object is not a regular file", "object_not_regular_file");
    if (stats.size !== record.sizeBytes) throw new StorageObjectError("storage object size does not match metadata", "object_size_mismatch");
    let fileDescriptor: number;
    try { fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY); } catch (error) {
      throw new StorageObjectError("storage object could not be opened", "object_open_failed", { cause: error });
    }
    return { record, filePath, fileDescriptor };
  }

  verify(objectId: string): ObjectVerification {
    if (!this.metadata(objectId)) {
      return {
        ok: false,
        code: "missing",
        message: "storage object row is missing",
      };
    }
    return verifyStorageObject(objectId, (value) => this.resolve(value));
  }
}

/**
 * Read-only capability used by public canonical catalog reads. It deliberately
 * does not expose the promotion methods on ObjectStore, so route integration
 * cannot accidentally acquire a writable object-store handle.
 */
export class ReadonlyObjectStore {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly paths: StoragePaths
  ) {}

  resolve(objectId: string, expectedKind?: ObjectKind): ResolvedStorageObject {
    const record = readStorageObjectRow(this.sqlite, objectId);
    if (!record) throw new StorageObjectError("storage object was not found", "object_not_found");
    if (expectedKind && record.objectKind !== expectedKind) throw new StorageObjectError("storage object kind does not match relationship", "object_kind_mismatch");
    if (record.state !== "available") throw new StorageObjectError("storage object is not available", "object_not_available");
    const expectedKey = expectedStorageKey(record.objectKind, record.objectId, record.mediaType);
    if (record.storageKey !== expectedKey || !SAFE_STORAGE_KEY.test(record.storageKey)) throw new StorageObjectError("storage object key is invalid", "object_storage_key_invalid");
    const filePath = path.resolve(this.paths.root, record.storageKey);
    assertNoSymlinkComponents(this.paths.objectRoot, filePath);
    let stats: fs.Stats;
    try { stats = fs.lstatSync(filePath); } catch (error) { throw new StorageObjectError("storage object file is missing", "object_file_missing", { cause: error }); }
    if (stats.isSymbolicLink()) throw new StorageObjectError("storage object file is a symlink", "object_symlink_rejected");
    if (!stats.isFile()) throw new StorageObjectError("storage object is not a regular file", "object_not_regular_file");
    if (stats.size !== record.sizeBytes) throw new StorageObjectError("storage object size does not match metadata", "object_size_mismatch");
    let fileDescriptor: number;
    try { fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY); } catch (error) { throw new StorageObjectError("storage object could not be opened", "object_open_failed", { cause: error }); }
    return { record, filePath, fileDescriptor };
  }

  verify(objectId: string): ObjectVerification {
    return verifyStorageObject(objectId, (value) => this.resolve(value));
  }
}

export function readStorageObjectRow(sqlite: Database.Database, objectId: string): StorageObjectRecord | null {
  assertObjectId(objectId);
  const row = sqlite.prepare("SELECT * FROM storage_objects WHERE object_id = ?").get(objectId) as Record<string, unknown> | undefined;
  return row ? recordFromRow(row) : null;
}
