import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BackupError } from "../backup/format.js";
import type {
  CanonicalBackupFaultPoint,
  CanonicalBackupLimits,
} from "./backup-contracts.js";

const CHUNK_BYTES = 1024 * 1024;

/** Describes one file that is written to the canonical backup archive. */
export interface ArchiveEntrySource {
  readonly archivePath: string;
  readonly sourcePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface ZipEntryIdentity {
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly crc32: number;
  readonly offset: number;
}

function crcTable(): readonly number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
}

const CRC_TABLE = crcTable();

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function streamCrcAndHash(
  sourcePath: string,
  outputFd: number,
  fault?: (point: CanonicalBackupFaultPoint) => void,
): {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly crc32: number;
} {
  const inputFd = fs.openSync(sourcePath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let crc = 0xffffffff;
  let sizeBytes = 0;
  try {
    while (true) {
      const count = fs.readSync(inputFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      sizeBytes += count;
      hash.update(chunk);
      for (const byte of chunk) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
      }
      fs.writeSync(outputFd, chunk);
      fault?.("during-object-streaming");
    }
  } finally {
    fs.closeSync(inputFd);
  }
  return {
    sizeBytes,
    sha256: hash.digest("hex"),
    crc32: (crc ^ 0xffffffff) >>> 0,
  };
}

function writeU16(fd: number, value: number): void {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  fs.writeSync(fd, buffer);
}

function writeU32(fd: number, value: number): void {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  fs.writeSync(fd, buffer);
}

function writeZipEntry(
  fd: number,
  entry: ArchiveEntrySource,
  fault?: (point: CanonicalBackupFaultPoint) => void,
): ZipEntryIdentity {
  const name = Buffer.from(entry.archivePath, "utf8");
  if (name.length > 0xffff || entry.sizeBytes > 0xffffffff) {
    throw new BackupError(
      "canonical backup ZIP entry exceeds format bounds",
      "canonical_backup_archive_unsupported",
    );
  }
  const offset = fs.fstatSync(fd).size;
  writeU32(fd, 0x04034b50);
  writeU16(fd, 20);
  writeU16(fd, 0x800);
  writeU16(fd, 0);
  writeU16(fd, 0);
  writeU16(fd, 0);
  writeU32(fd, 0);
  writeU32(fd, entry.sizeBytes);
  writeU32(fd, entry.sizeBytes);
  writeU16(fd, name.length);
  writeU16(fd, 0);
  fs.writeSync(fd, name);
  const streamed = streamCrcAndHash(entry.sourcePath, fd, fault);
  if (
    streamed.sizeBytes !== entry.sizeBytes ||
    streamed.sha256 !== entry.sha256
  ) {
    throw new BackupError(
      "canonical source changed while creating backup",
      "canonical_backup_source_changed",
    );
  }
  return { name: entry.archivePath, ...streamed, offset };
}

/** Writes a deterministic, uncompressed canonical backup ZIP archive. */
export function writeCanonicalZipArchive(
  outputPath: string,
  entries: readonly ArchiveEntrySource[],
  manifestBytes: Buffer,
  manifestHash: string,
  limitsValue: CanonicalBackupLimits,
  fault?: (point: CanonicalBackupFaultPoint) => void,
): { readonly archiveBytes: number; readonly archiveSha256: string } {
  const temporary = `${outputPath}.partial-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
    0o600,
  );
  const central: ZipEntryIdentity[] = [];
  const manifestPath = `${temporary}.manifest`;
  const sidecarPath = `${temporary}.manifest.sha256`;
  try {
    fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
    fs.writeFileSync(sidecarPath, `${manifestHash}\n`, { mode: 0o600 });
    const allEntries: ArchiveEntrySource[] = [
      {
        archivePath: "manifest.json",
        sourcePath: manifestPath,
        sizeBytes: manifestBytes.byteLength,
        sha256: hashText(manifestBytes.toString("utf8")),
      },
      {
        archivePath: "manifest.sha256",
        sourcePath: sidecarPath,
        sizeBytes: Buffer.byteLength(`${manifestHash}\n`),
        sha256: hashText(`${manifestHash}\n`),
      },
      ...entries,
    ];
    for (const entry of allEntries) {
      if (central.length >= limitsValue.maxEntries) {
        throw new BackupError(
          "canonical backup contains too many entries",
          "canonical_backup_too_many_entries",
        );
      }
      if (entry.sizeBytes > limitsValue.maxEntryBytes) {
        throw new BackupError(
          "canonical backup entry is too large",
          "canonical_backup_entry_too_large",
        );
      }
      central.push(writeZipEntry(fd, entry, fault));
    }
    fault?.("before-archive-finalization");
    const centralOffset = fs.fstatSync(fd).size;
    for (const item of central) {
      const name = Buffer.from(item.name, "utf8");
      writeU32(fd, 0x02014b50);
      writeU16(fd, 20);
      writeU16(fd, 20);
      writeU16(fd, 0x800);
      writeU16(fd, 0);
      writeU16(fd, 0);
      writeU16(fd, 0);
      writeU32(fd, item.crc32);
      writeU32(fd, item.sizeBytes);
      writeU32(fd, item.sizeBytes);
      writeU16(fd, name.length);
      writeU16(fd, 0);
      writeU16(fd, 0);
      writeU16(fd, 0);
      writeU16(fd, 0);
      writeU32(fd, 0);
      writeU32(fd, item.offset);
      fs.writeSync(fd, name);
    }
    const centralSize = fs.fstatSync(fd).size - centralOffset;
    writeU32(fd, 0x06054b50);
    writeU16(fd, 0);
    writeU16(fd, 0);
    writeU16(fd, central.length);
    writeU16(fd, central.length);
    writeU32(fd, centralSize);
    writeU32(fd, centralOffset);
    writeU16(fd, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(manifestPath, { force: true });
    fs.rmSync(sidecarPath, { force: true });
  }
  fs.renameSync(temporary, outputPath);
  const outputDirectory = fs.openSync(
    path.dirname(outputPath),
    fs.constants.O_RDONLY,
  );
  try {
    fs.fsyncSync(outputDirectory);
  } finally {
    fs.closeSync(outputDirectory);
  }
  fault?.("after-archive-finalization");
  const archiveIdentity = sha256File(outputPath);
  if (archiveIdentity.sizeBytes > limitsValue.maxArchiveBytes) {
    throw new BackupError(
      "canonical backup archive is too large",
      "canonical_backup_archive_too_large",
    );
  }
  return {
    archiveBytes: archiveIdentity.sizeBytes,
    archiveSha256: archiveIdentity.sha256,
  };
}

/** Predicts the byte size of the canonical ZIP before writing it. */
export function predictedCanonicalZipBytes(
  entries: readonly ArchiveEntrySource[],
  manifestBytes: Buffer,
): number {
  const sidecarBytes = 65;
  const all = [
    { name: "manifest.json", size: manifestBytes.byteLength },
    { name: "manifest.sha256", size: sidecarBytes },
    ...entries.map((entry) => ({
      name: entry.archivePath,
      size: entry.sizeBytes,
    })),
  ];
  const local = all.reduce(
    (total, entry) =>
      total + 30 + Buffer.byteLength(entry.name, "utf8") + entry.size,
    0,
  );
  const central = all.reduce(
    (total, entry) =>
      total + 46 + Buffer.byteLength(entry.name, "utf8"),
    0,
  );
  return local + central + 22;
}

function sha256File(filePath: string): {
  readonly sizeBytes: number;
  readonly sha256: string;
} {
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new BackupError(
      "canonical backup requires regular files",
      "canonical_backup_file_invalid",
    );
  }
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let sizeBytes = 0;
  try {
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      sizeBytes += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}
