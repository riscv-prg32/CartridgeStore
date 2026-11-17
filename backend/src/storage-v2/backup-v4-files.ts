import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BackupError } from "../backup/format.js";
import {
  BACKUP_V4_NONCE_BYTES,
  BACKUP_V4_TAG_BYTES,
  backupV4HeaderBytes,
  decodeBackupV4Base64,
  parseBackupV4Header,
} from "./backup-v4-codecs.js";
import type {
  EncryptedBackupV4FaultPoint,
  EncryptedBackupV4Header,
  EncryptedBackupV4Limits,
} from "./backup-v4-contracts.js";

/** PRG32 encrypted backup envelope magic bytes. */
export const ENCRYPTED_BACKUP_V4_MAGIC = Buffer.from(
  "PRG32-BACKUP-V4\0",
  "ascii",
);

/** Shared streaming chunk size for encrypted backup file I/O. */
export const ENCRYPTED_BACKUP_CHUNK_BYTES = 1024 * 1024;

/** Parsed offsets and authenticated data for an encrypted backup envelope. */
export interface ParsedEncryptedBackupEnvelope {
  readonly header: EncryptedBackupV4Header;
  readonly headerRaw: Buffer;
  readonly ciphertextOffset: number;
  readonly ciphertextBytes: number;
  readonly tag: Buffer;
  readonly sizeBytes: number;
}

/** Hashes an encrypted archive for its completion marker. */
export function sha256EncryptedBackupFile(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.alloc(ENCRYPTED_BACKUP_CHUNK_BYTES);
  try {
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Resolves and validates an encrypted-backup path. */
export function resolveEncryptedBackupPath(
  value: string,
  label: string,
): string {
  if (!value || value.trim() === "") {
    throw new BackupError(
      `${label} is required`,
      "backup_v4_path_required",
    );
  }
  const result = path.resolve(value);
  if (result === path.parse(result).root) {
    throw new BackupError(
      `${label} may not be the filesystem root`,
      "backup_v4_path_unsafe",
    );
  }
  return result;
}

/** Requires a regular file and returns its stat information. */
export function requireRegularBackupFile(
  filePath: string,
  code: string,
): fs.Stats {
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new BackupError("backup path must be a regular file", code);
  }
  return stats;
}

/** Parses and validates the encrypted backup envelope header and offsets. */
export function parseEncryptedBackupEnvelope(
  filePath: string,
  limits: EncryptedBackupV4Limits,
): ParsedEncryptedBackupEnvelope {
  const stats = requireRegularBackupFile(
    filePath,
    "backup_v4_archive_invalid",
  );
  if (stats.size > limits.maxEnvelopeBytes) {
    throw new BackupError(
      "backup v4 envelope is too large",
      "backup_v4_archive_too_large",
    );
  }
  if (
    stats.size <
    ENCRYPTED_BACKUP_V4_MAGIC.byteLength + 4 + BACKUP_V4_TAG_BYTES + 1
  ) {
    throw new BackupError(
      "backup v4 envelope is truncated",
      "backup_v4_archive_truncated",
    );
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const magic = Buffer.alloc(ENCRYPTED_BACKUP_V4_MAGIC.byteLength);
    fs.readSync(fd, magic, 0, magic.length, 0);
    if (!magic.equals(ENCRYPTED_BACKUP_V4_MAGIC)) {
      throw new BackupError(
        "backup v4 magic is invalid",
        "backup_v4_format_unsupported",
      );
    }
    const lengthBuffer = Buffer.alloc(4);
    fs.readSync(
      fd,
      lengthBuffer,
      0,
      4,
      ENCRYPTED_BACKUP_V4_MAGIC.byteLength,
    );
    const length = lengthBuffer.readUInt32BE(0);
    if (length < 2 || length > limits.maxHeaderBytes) {
      throw new BackupError(
        "backup v4 header length is invalid",
        "backup_v4_header_invalid",
      );
    }
    const raw = Buffer.alloc(length);
    const read = fs.readSync(
      fd,
      raw,
      0,
      length,
      ENCRYPTED_BACKUP_V4_MAGIC.byteLength + 4,
    );
    if (read !== length) {
      throw new BackupError(
        "backup v4 header is truncated",
        "backup_v4_archive_truncated",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
    } catch (error) {
      throw new BackupError(
        "backup v4 header is invalid",
        "backup_v4_header_invalid",
        400,
        { cause: error },
      );
    }
    const header = parseBackupV4Header(parsed, limits.maxHeaderBytes);
    if (header.payload_archive_bytes > limits.maxPayloadBytes) {
      throw new BackupError(
        "backup v4 payload is too large",
        "backup_v4_payload_too_large",
      );
    }
    const ciphertextOffset =
      ENCRYPTED_BACKUP_V4_MAGIC.byteLength + 4 + length;
    const ciphertextBytes =
      stats.size - ciphertextOffset - BACKUP_V4_TAG_BYTES;
    if (
      ciphertextBytes !== header.payload_archive_bytes ||
      ciphertextBytes < 1
    ) {
      throw new BackupError(
        "backup v4 ciphertext length is inconsistent",
        "backup_v4_archive_truncated",
      );
    }
    return {
      header,
      headerRaw: raw,
      ciphertextOffset,
      ciphertextBytes,
      tag: readAt(fd, stats.size - BACKUP_V4_TAG_BYTES, BACKUP_V4_TAG_BYTES),
      sizeBytes: stats.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes an authenticated encrypted backup envelope atomically. */
export function writeEncryptedBackupEnvelope(
  outputPath: string,
  payloadPath: string,
  header: EncryptedBackupV4Header,
  dataKey: Buffer,
  limits: EncryptedBackupV4Limits,
  fault?: (point: EncryptedBackupV4FaultPoint) => void,
): number {
  const temporary = `${outputPath}.partial-${process.pid}-${crypto.randomUUID()}`;
  const rawHeader = backupV4HeaderBytes(header);
  const fdIn = fs.openSync(payloadPath, "r");
  const fdOut = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    dataKey,
    decodeBackupV4Base64(header.nonce, BACKUP_V4_NONCE_BYTES, "nonce"),
    { authTagLength: BACKUP_V4_TAG_BYTES },
  );
  cipher.setAAD(rawHeader);
  try {
    fs.writeSync(fdOut, ENCRYPTED_BACKUP_V4_MAGIC);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(rawHeader.byteLength, 0);
    fs.writeSync(fdOut, length);
    fs.writeSync(fdOut, rawHeader);
    const input = Buffer.alloc(ENCRYPTED_BACKUP_CHUNK_BYTES);
    let position = 0;
    while (position < header.payload_archive_bytes) {
      const count = fs.readSync(
        fdIn,
        input,
        0,
        Math.min(input.length, header.payload_archive_bytes - position),
        position,
      );
      if (count === 0) {
        throw new BackupError(
          "backup payload is truncated",
          "backup_v4_payload_truncated",
        );
      }
      position += count;
      const encrypted = cipher.update(input.subarray(0, count));
      if (encrypted.length > 0) fs.writeSync(fdOut, encrypted);
      fault?.("during-encryption");
    }
    const final = cipher.final();
    if (final.length > 0) fs.writeSync(fdOut, final);
    fault?.("before-envelope-finalization");
    fs.writeSync(fdOut, cipher.getAuthTag());
    fs.fsyncSync(fdOut);
  } finally {
    fs.closeSync(fdIn);
    fs.closeSync(fdOut);
  }
  fs.renameSync(temporary, outputPath);
  const directory = fs.openSync(path.dirname(outputPath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
  const stats = requireRegularBackupFile(
    outputPath,
    "backup_v4_archive_invalid",
  );
  if (stats.size > limits.maxEnvelopeBytes) {
    throw new BackupError(
      "backup v4 envelope is too large",
      "backup_v4_archive_too_large",
    );
  }
  fault?.("after-envelope-finalization");
  return stats.size;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const result = Buffer.alloc(length);
  const read = fs.readSync(fd, result, 0, length, position);
  if (read !== length) {
    throw new BackupError(
      "backup v4 envelope is truncated",
      "backup_v4_archive_truncated",
    );
  }
  return result;
}
