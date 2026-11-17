import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CARTRIDGE_MEDIA_TYPE, MAX_OBJECT_BYTES } from "./objects.js";
import { SUPPORTED_ARCHITECTURES, type Architecture, type StoragePaths } from "./types.js";

export class StorageStagingError extends Error {
  readonly code: string;

  constructor(message: string, code = "storage_staging_invalid", options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageStagingError";
    this.code = code;
  }
}

export interface StagedSubmissionArtifact {
  readonly submissionId: number;
  readonly architecture: Architecture;
  readonly sourceFilename: string;
  readonly stagingKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: typeof CARTRIDGE_MEDIA_TYPE;
}

function assertArchitecture(value: string): asserts value is Architecture {
  if (!SUPPORTED_ARCHITECTURES.includes(value as Architecture)) {
    throw new StorageStagingError("architecture is invalid", "staging_architecture_invalid");
  }
}

function assertSubmissionId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StorageStagingError("submission identifier is invalid", "staging_submission_id_invalid");
  }
}

function assertSourceFilename(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new StorageStagingError("source filename is invalid", "staging_filename_invalid");
  }
}

function assertSafeDirectory(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StorageStagingError("staging path escapes the staging root", "staging_path_unsafe");
  }
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new StorageStagingError("staging path contains a symlink", "staging_symlink_rejected");
    }
  }
}

/** Writes the isolated staging primitive without creating a submission row. */
export class StagingStore {
  constructor(
    private readonly paths: StoragePaths,
    private readonly maxBytes = MAX_OBJECT_BYTES
  ) {}

  stageSubmissionArtifact(
    submissionId: number,
    architecture: Architecture,
    sourceFilename: string,
    bytes: Uint8Array
  ): StagedSubmissionArtifact {
    assertSubmissionId(submissionId);
    assertArchitecture(architecture);
    assertSourceFilename(sourceFilename);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new StorageStagingError("staged artifact bytes are invalid", "staging_bytes_invalid");
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new StorageStagingError("staged artifact exceeds the configured size limit", "staging_object_too_large");
    }

    const submissionRoot = path.join(this.paths.submissionStagingRoot, String(submissionId));
    const artifactRoot = path.join(submissionRoot, "artifacts");
    const finalPath = path.join(artifactRoot, `${architecture}.prg32`);
    const temporaryRoot = path.join(submissionRoot, ".tmp");
    assertSafeDirectory(this.paths.submissionStagingRoot, artifactRoot);
    fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
    assertSafeDirectory(this.paths.submissionStagingRoot, temporaryRoot);
    if (fs.existsSync(finalPath)) {
      throw new StorageStagingError("submission staging destination already exists", "staging_destination_exists");
    }

    const temporaryPath = path.join(temporaryRoot, `${architecture}.${crypto.randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      const hash = crypto.createHash("sha256");
      hash.update(bytes);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      if (fs.existsSync(finalPath)) {
        throw new StorageStagingError("submission staging destination already exists", "staging_destination_exists");
      }
      fs.linkSync(temporaryPath, finalPath);
      fs.unlinkSync(temporaryPath);
      const directoryDescriptor = fs.openSync(artifactRoot, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
      return {
        submissionId,
        architecture,
        sourceFilename,
        stagingKey: `storage/staging/submissions/${submissionId}/artifacts/${architecture}.prg32`,
        sha256: hash.digest("hex"),
        sizeBytes: bytes.byteLength,
        mediaType: CARTRIDGE_MEDIA_TYPE
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
      }
      if (error instanceof StorageStagingError) throw error;
      throw new StorageStagingError("submission staging failed", "staging_write_failed", { cause: error });
    }
  }
}
