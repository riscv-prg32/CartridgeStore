/**
 * ZIP archive scanning, extraction, and creation for backups.
 */

import fs from "node:fs";
import path from "node:path";

import { Unzip, UnzipInflate, UnzipPassThrough, zipSync } from "fflate";

import type { BackendConfig } from "../../config/env.js";
import {
  BackupError,
  normalizeArchivePath,
  validateArchiveEntryPath
} from "../format.js";

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_CHUNK_BYTES = 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 128 * 1024 * 1024;

/** Metadata read from a validated ZIP central-directory entry. */
export interface ZipEntryRecord {
  readonly name: string;
  readonly directory: boolean;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly compression: number;
  readonly unixMode: number | null;
}

/** Paths and size totals produced after extracting a validated backup ZIP. */
export interface ExtractedArchive {
  readonly entries: ReadonlyMap<string, ZipEntryRecord>;
  readonly manifestPath: string;
  readonly databasePath: string;
  readonly dataPath: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
}

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

function uint32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BackupError(
      "backup archive size is invalid",
      "backup_archive_invalid"
    );
  }
  return value;
}

function decodeName(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new BackupError(
      "backup archive filename is not valid UTF-8",
      "backup_unsafe_path",
      400,
      { cause: error }
    );
  }
}

function validateFileType(
  versionMadeBy: number,
  externalAttributes: number,
  directory: boolean
): number | null {
  const host = versionMadeBy >>> 8;
  if (host !== 3) return null;
  const mode = externalAttributes >>> 16;
  const type = mode & 0xf000;
  if (type !== 0 && type !== 0x8000 && type !== 0x4000) {
    throw new BackupError(
      "backup contains an unsupported file type",
      "backup_unsupported_file_type"
    );
  }
  if (directory && type === 0x8000) {
    throw new BackupError(
      "backup directory metadata is invalid",
      "backup_unsupported_file_type"
    );
  }
  return mode;
}

function locateEndOfCentralDirectory(
  fd: number,
  size: number
): {
  readonly entries: number;
  readonly directorySize: number;
  readonly directoryOffset: number;
} {
  const length = Math.min(size, 65557);
  const start = size - length;
  const tail = readAt(fd, start, length);
  for (let index = length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_EOCD) continue;
    const entries = tail.readUInt16LE(index + 10);
    const directorySize = uint32(tail.readUInt32LE(index + 12));
    const directoryOffset = uint32(tail.readUInt32LE(index + 16));
    if (
      entries === 0xffff ||
      directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff
    ) {
      throw new BackupError(
        "ZIP64 backups are not supported",
        "backup_archive_unsupported"
      );
    }
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength > length) continue;
    return { entries, directorySize, directoryOffset };
  }
  throw new BackupError(
    "backup archive has no central directory",
    "backup_archive_invalid"
  );
}

/** Scan and validate the ZIP central directory without extracting entries. */
export function scanZipArchive(
  zipPath: string,
  config: BackendConfig
): {
  readonly entries: readonly ZipEntryRecord[];
  readonly expandedBytes: number;
  readonly compressedBytes: number;
} {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(zipPath);
  } catch (error) {
    throw new BackupError(
      "backup archive is unavailable",
      "backup_archive_invalid",
      400,
      { cause: error }
    );
  }
  if (!stats.isFile()) {
    throw new BackupError(
      "backup archive is not a regular file",
      "backup_archive_invalid"
    );
  }
  if (stats.size <= 0 || stats.size > config.backupMaxArchiveBytes) {
    throw new BackupError(
      "backup archive is too large",
      "backup_archive_too_large",
      413
    );
  }
  const fd = fs.openSync(zipPath, "r");
  try {
    const directory = locateEndOfCentralDirectory(fd, stats.size);
    if (directory.entries > config.backupMaxEntries) {
      throw new BackupError(
        "backup contains too many entries",
        "backup_too_many_entries"
      );
    }
    if (
      directory.directorySize > MAX_CENTRAL_DIRECTORY_BYTES ||
      directory.directoryOffset + directory.directorySize > stats.size
    ) {
      throw new BackupError(
        "backup central directory is invalid",
        "backup_archive_invalid"
      );
    }
    const bytes = readAt(fd, directory.directoryOffset, directory.directorySize);
    const entries: ZipEntryRecord[] = [];
    const seen = new Set<string>();
    let cursor = 0;
    let expandedBytes = 0;
    let compressedBytes = 0;
    for (let index = 0; index < directory.entries; index += 1) {
      if (
        cursor + 46 > bytes.length ||
        bytes.readUInt32LE(cursor) !== ZIP_CENTRAL
      ) {
        throw new BackupError(
          "backup central directory is malformed",
          "backup_archive_invalid"
        );
      }
      const madeBy = bytes.readUInt16LE(cursor + 4);
      const flags = bytes.readUInt16LE(cursor + 8);
      const compression = bytes.readUInt16LE(cursor + 10);
      const compressedSize = uint32(bytes.readUInt32LE(cursor + 20));
      const uncompressedSize = uint32(bytes.readUInt32LE(cursor + 24));
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extraLength = bytes.readUInt16LE(cursor + 30);
      const commentLength = bytes.readUInt16LE(cursor + 32);
      const externalAttributes = bytes.readUInt32LE(cursor + 38);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (cursor + recordLength > bytes.length) {
        throw new BackupError(
          "backup central directory is truncated",
          "backup_archive_invalid"
        );
      }
      const rawName = decodeName(
        bytes.subarray(cursor + 46, cursor + 46 + nameLength)
      );
      const normalized = normalizeArchivePath(rawName, config);
      const name = normalized.path;
      if (seen.has(name)) {
        throw new BackupError(
          "backup contains duplicate normalized paths",
          "backup_duplicate_entry"
        );
      }
      seen.add(name);
      if ((flags & 0x1) !== 0) {
        throw new BackupError(
          "encrypted ZIP entries are unsupported",
          "backup_archive_unsupported"
        );
      }
      if (compression !== 0 && compression !== 8) {
        throw new BackupError(
          "backup uses an unsupported compression method",
          "backup_archive_unsupported"
        );
      }
      if (uncompressedSize > config.backupMaxEntryBytes) {
        throw new BackupError(
          "backup entry is too large",
          "backup_entry_too_large"
        );
      }
      expandedBytes += uncompressedSize;
      compressedBytes += compressedSize;
      if (
        !Number.isSafeInteger(expandedBytes) ||
        expandedBytes > config.backupMaxExpandedBytes
      ) {
        throw new BackupError(
          "backup expanded data is too large",
          "backup_expanded_too_large"
        );
      }
      if (
        uncompressedSize > 0 &&
        uncompressedSize / Math.max(compressedSize, 1) >
          config.backupMaxCompressionRatio
      ) {
        throw new BackupError(
          "backup compression ratio is too high",
          "backup_compression_ratio"
        );
      }
      validateArchiveEntryPath(rawName, config);
      entries.push({
        name,
        directory: normalized.directory,
        compressedSize,
        uncompressedSize,
        compression,
        unixMode: validateFileType(
          madeBy,
          externalAttributes,
          normalized.directory
        )
      });
      cursor += recordLength;
    }
    if (cursor !== bytes.length) {
      throw new BackupError(
        "backup central directory has trailing data",
        "backup_archive_invalid"
      );
    }
    if (compressedBytes > stats.size) {
      throw new BackupError(
        "backup entry sizes are invalid",
        "backup_archive_invalid"
      );
    }
    return { entries, expandedBytes, compressedBytes };
  } finally {
    fs.closeSync(fd);
  }
}

function safeOutputPath(
  destination: string,
  name: string,
  config: BackendConfig
): string {
  const normalized = normalizeArchivePath(name, config);
  const candidate = path.resolve(destination, normalized.path);
  const root = path.resolve(destination);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new BackupError(
      "backup extraction path is unsafe",
      "backup_unsafe_path"
    );
  }
  return candidate;
}

/** Extract a validated ZIP archive into a private destination directory. */
export function extractZipArchive(
  zipPath: string,
  destination: string,
  config: BackendConfig
): ExtractedArchive {
  const scanned = scanZipArchive(zipPath, config);
  const records = new Map(scanned.entries.map((entry) => [entry.name, entry]));
  const files = new Set<string>();
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  let activeError: unknown;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    const record = records.get(normalizeArchivePath(file.name, config).path);
    if (!record) {
      throw new BackupError(
        "backup archive differs from its central directory",
        "backup_archive_invalid"
      );
    }
    if (record.directory) {
      files.add(record.name);
      return;
    }
    const target = safeOutputPath(destination, record.name, config);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(target, "wx", 0o600);
    let written = 0;
    file.ondata = (error, chunk, final) => {
      if (error) {
        activeError = error;
        try {
          fs.closeSync(fd);
        } catch {
          // Best effort cleanup after an extraction error.
        }
        return;
      }
      if (chunk) {
        written += chunk.byteLength;
        if (written > config.backupMaxEntryBytes) {
          activeError = new BackupError(
            "backup entry is too large",
            "backup_entry_too_large"
          );
          return;
        }
        fs.writeSync(fd, Buffer.from(chunk));
      }
      if (final) {
        fs.closeSync(fd);
        if (written !== record.uncompressedSize) {
          activeError = new BackupError(
            "backup entry size is inconsistent",
            "backup_entry_size_mismatch"
          );
        }
        files.add(record.name);
      }
    };
    file.start();
  };
  const inputFd = fs.openSync(zipPath, "r");
  try {
    const input = Buffer.alloc(ZIP_CHUNK_BYTES);
    let position = 0;
    const size = fs.statSync(zipPath).size;
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
          "backup archive is truncated",
          "backup_archive_invalid"
        );
      }
      position += read;
      unzip.push(input.subarray(0, read), position === size);
      if (activeError) {
        if (activeError instanceof BackupError) throw activeError;
        throw new BackupError(
          "backup archive could not be extracted",
          "backup_archive_invalid",
          400,
          { cause: activeError }
        );
      }
    }
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      "backup archive could not be extracted",
      "backup_archive_invalid",
      400,
      { cause: error }
    );
  } finally {
    fs.closeSync(inputFd);
  }
  if (activeError) {
    if (activeError instanceof BackupError) throw activeError;
    throw new BackupError(
      "backup archive could not be extracted",
      "backup_archive_invalid",
      400,
      { cause: activeError }
    );
  }
  if (files.size !== records.size) {
    throw new BackupError(
      "backup extraction was incomplete",
      "backup_archive_invalid"
    );
  }
  return {
    entries: records,
    manifestPath: path.join(destination, "manifest.json"),
    databasePath: path.join(destination, "database.sqlite"),
    dataPath: path.join(destination, "data"),
    compressedBytes: scanned.compressedBytes,
    expandedBytes: scanned.expandedBytes
  };
}

/** Create a ZIP buffer from the provided archive entries. */
export function createZip(entries: Record<string, Uint8Array>): Buffer {
  try {
    return Buffer.from(zipSync(entries, { level: 6 }));
  } catch (error) {
    throw new BackupError(
      "backup archive could not be created",
      "backup_export_failed",
      500,
      { cause: error }
    );
  }
}
