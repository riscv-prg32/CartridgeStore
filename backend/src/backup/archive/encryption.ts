/**
 * Backup archive encryption and decryption.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import {
  BACKUP_ENCRYPTION_MAGIC,
  BackupError
} from "../format.js";

const ZIP_CHUNK_BYTES = 1024 * 1024;

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(
      fd,
      buffer,
      offset,
      length - offset,
      position + offset
    );
    if (read === 0) {
      throw new BackupError(
        "backup archive is truncated",
        "backup_archive_invalid"
      );
    }
    offset += read;
  }
  return buffer;
}

function passwordKey(password: string, salt: Buffer): Buffer {
  if (typeof password !== "string" || password.length < 1) {
    throw new BackupError(
      "backup password is required",
      "backup_password_required"
    );
  }
  return crypto.scryptSync(password, salt, 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 132 * (2 ** 15) * 8
  });
}

function readEncryptionHeader(filePath: string): {
  readonly header: Record<string, unknown>;
  readonly headerBytes: Buffer;
  readonly ciphertextOffset: number;
  readonly tag: Buffer;
} {
  const fd = fs.openSync(filePath, "r");
  try {
    const prefix = Buffer.alloc(
      Math.min(fs.statSync(filePath).size, 64 * 1024)
    );
    fs.readSync(fd, prefix, 0, prefix.length, 0);
    if (
      !prefix
        .subarray(0, BACKUP_ENCRYPTION_MAGIC.length)
        .equals(BACKUP_ENCRYPTION_MAGIC)
    ) {
      throw new BackupError(
        "backup encryption header is invalid",
        "backup_encryption_invalid"
      );
    }
    const lineEnd = prefix.indexOf(0x0a, BACKUP_ENCRYPTION_MAGIC.length);
    if (lineEnd < 0) {
      throw new BackupError(
        "backup encryption header is invalid",
        "backup_encryption_invalid"
      );
    }
    const headerBytes = prefix.subarray(
      BACKUP_ENCRYPTION_MAGIC.length,
      lineEnd + 1
    );
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(headerBytes.toString("utf8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      throw new BackupError(
        "backup encryption header is invalid",
        "backup_encryption_invalid",
        400,
        { cause: error }
      );
    }
    const stats = fs.statSync(filePath);
    if (stats.size <= lineEnd + 1 + 16) {
      throw new BackupError(
        "encrypted backup is truncated",
        "backup_encryption_invalid"
      );
    }
    const tag = readAt(fd, stats.size - 16, 16);
    return {
      header,
      headerBytes,
      ciphertextOffset: lineEnd + 1,
      tag
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Encrypt a ZIP backup using the repository's established format. */
export function encryptBackup(
  zipPath: string,
  outputPath: string,
  password: string
): void {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = passwordKey(password, salt);
  const headerObject = {
    version: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag_bytes: 16
  };
  const headerBytes = Buffer.from(`${JSON.stringify(headerObject)}\n`, "utf8");
  const inputFd = fs.openSync(zipPath, "r");
  const outputFd = fs.openSync(outputPath, "wx", 0o600);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(headerBytes);
  try {
    fs.writeSync(outputFd, BACKUP_ENCRYPTION_MAGIC);
    fs.writeSync(outputFd, headerBytes);
    const input = Buffer.alloc(ZIP_CHUNK_BYTES);
    const size = fs.statSync(zipPath).size;
    let position = 0;
    while (position < size) {
      const read = fs.readSync(
        inputFd,
        input,
        0,
        Math.min(input.length, size - position),
        position
      );
      if (read === 0) {
        throw new BackupError(
          "backup source is truncated",
          "backup_archive_invalid"
        );
      }
      position += read;
      const encrypted = cipher.update(input.subarray(0, read));
      if (encrypted.length > 0) fs.writeSync(outputFd, encrypted);
    }
    const final = cipher.final();
    if (final.length > 0) fs.writeSync(outputFd, final);
    fs.writeSync(outputFd, cipher.getAuthTag());
    fs.fsyncSync(outputFd);
  } finally {
    fs.closeSync(inputFd);
    fs.closeSync(outputFd);
  }
}

/** Decrypt a backup archive into a ZIP file. */
export function decryptBackup(
  inputPath: string,
  outputPath: string,
  password: string
): void {
  const parsed = readEncryptionHeader(inputPath);
  const version = parsed.header.version;
  const cipherName = parsed.header.cipher;
  const kdf = parsed.header.kdf;
  const saltValue = parsed.header.salt;
  const ivValue = parsed.header.iv;
  if (
    version !== 1 ||
    cipherName !== "aes-256-gcm" ||
    kdf !== "scrypt" ||
    typeof saltValue !== "string" ||
    typeof ivValue !== "string"
  ) {
    throw new BackupError(
      "backup encryption format is unsupported",
      "backup_encryption_unsupported"
    );
  }
  const salt = Buffer.from(saltValue, "base64url");
  const iv = Buffer.from(ivValue, "base64url");
  if (salt.length !== 16 || iv.length !== 12) {
    throw new BackupError(
      "backup encryption header is invalid",
      "backup_encryption_invalid"
    );
  }
  const key = passwordKey(password, salt);
  const stats = fs.statSync(inputPath);
  const ciphertextEnd = stats.size - 16;
  const inputFd = fs.openSync(inputPath, "r");
  const outputFd = fs.openSync(outputPath, "wx", 0o600);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(parsed.headerBytes);
  decipher.setAuthTag(parsed.tag);
  try {
    const input = Buffer.alloc(ZIP_CHUNK_BYTES);
    let position = parsed.ciphertextOffset;
    while (position < ciphertextEnd) {
      const read = fs.readSync(
        inputFd,
        input,
        0,
        Math.min(input.length, ciphertextEnd - position),
        position
      );
      if (read === 0) {
        throw new BackupError(
          "encrypted backup is truncated",
          "backup_encryption_invalid"
        );
      }
      position += read;
      const plain = decipher.update(input.subarray(0, read));
      if (plain.length > 0) fs.writeSync(outputFd, plain);
    }
    const final = decipher.final();
    if (final.length > 0) fs.writeSync(outputFd, final);
    fs.fsyncSync(outputFd);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      "backup password is invalid or archive was tampered with",
      "backup_decryption_failed",
      400,
      { cause: error }
    );
  } finally {
    fs.closeSync(inputFd);
    fs.closeSync(outputFd);
  }
}
