import { unzipSync } from "fflate";

import type { BackendConfig } from "../config/env.js";
import { SubmissionError } from "./errors.js";

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

const ZIP_SIGNATURES = [0x04034b50, 0x06054b50, 0x08074b50];

function safeArchiveName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const directory = normalized.endsWith("/");
  const candidate = directory ? normalized.slice(0, -1) : normalized;
  if (!candidate || candidate.includes("\0") || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) {
    throw new SubmissionError("bundle filename must be a safe relative filename");
  }
  const parts = candidate.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new SubmissionError("bundle filename must be a safe relative filename");
  }
  return value;
}

function zipSignature(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  const signature = (data[0] ?? 0) | ((data[1] ?? 0) << 8) | ((data[2] ?? 0) << 16) | ((data[3] ?? 0) << 24);
  return ZIP_SIGNATURES.includes(signature >>> 0);
}

function sizeNumber(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SubmissionError(`bundle ${label} is invalid`);
  return value;
}

function decompressBounded(data: Uint8Array, config: BackendConfig): Map<string, ZipEntry> {
  if (!zipSignature(data)) throw new SubmissionError("bundle must be a zip file");
  const entries = new Map<string, { compressedSize: number; uncompressedSize: number }>();
  const seenNames = new Set<string>();
  let declaredTotal = 0;
  let fileCount = 0;
  try {
    const unzipped = unzipSync(data, {
      filter: (info) => {
        const name = safeArchiveName(info.name);
        const isDirectory = name.endsWith("/");
        if (seenNames.has(name)) throw new SubmissionError("bundle contains duplicate filenames");
        seenNames.add(name);
        fileCount += 1;
        if (fileCount > config.submissionMaxEntries) throw new SubmissionError("bundle contains too many entries");
        const compressedSize = sizeNumber(info.size, "compressed entry size");
        const uncompressedSize = sizeNumber(info.originalSize, "entry size");
        if (uncompressedSize > config.submissionMaxEntryUncompressedBytes) throw new SubmissionError("bundle entry is too large");
        declaredTotal += uncompressedSize;
        if (declaredTotal > config.submissionMaxTotalUncompressedBytes) throw new SubmissionError("bundle uncompressed data is too large");
        if (uncompressedSize > 0 && uncompressedSize / Math.max(compressedSize, 1) > config.submissionMaxCompressionRatio) {
          throw new SubmissionError("bundle compression ratio is too high");
        }
        if (isDirectory) return false;
        entries.set(name, { compressedSize, uncompressedSize });
        return true;
      }
    });
    const result = new Map<string, ZipEntry>();
    let actualTotal = 0;
    for (const [name, raw] of Object.entries(unzipped)) {
      const declaration = entries.get(name);
      if (!declaration) throw new SubmissionError("bundle contains an invalid entry");
      const actualSize = raw.byteLength;
      if (actualSize !== declaration.uncompressedSize) throw new SubmissionError("bundle entry size is inconsistent");
      if (actualSize > config.submissionMaxEntryUncompressedBytes) throw new SubmissionError("bundle entry is too large");
      actualTotal += actualSize;
      if (actualTotal > config.submissionMaxTotalUncompressedBytes) throw new SubmissionError("bundle uncompressed data is too large");
      result.set(name, { name, data: raw, ...declaration, uncompressedSize: actualSize });
    }
    if (result.size !== entries.size) throw new SubmissionError("bundle entry extraction was incomplete");
    return result;
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError("bundle must be a valid zip file", "invalid_request", 400, { cause: error });
  }
}

export function parseZipArchive(data: Uint8Array, config: BackendConfig): Map<string, ZipEntry> {
  if (data.byteLength === 0) throw new SubmissionError("empty upload: bundle");
  if (data.byteLength > config.submissionMaxArchiveBytes) {
    throw new SubmissionError("bundle upload is too large", "submission_payload_too_large", 413);
  }
  return decompressBounded(data, config);
}
