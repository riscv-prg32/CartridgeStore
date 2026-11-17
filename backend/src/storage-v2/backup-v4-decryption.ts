import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BackupError } from "../backup/format.js";
import {
  ENCRYPTED_BACKUP_CHUNK_BYTES,
  parseEncryptedBackupEnvelope,
  requireRegularBackupFile,
  type ParsedEncryptedBackupEnvelope,
} from "./backup-v4-files.js";
import {
  BACKUP_V4_NONCE_BYTES,
  BACKUP_V4_TAG_BYTES,
  decodeBackupV4Base64,
  unwrapBackupV4DataKey,
} from "./backup-v4-codecs.js";
import type {
  BackupKeyProvider,
  EncryptedBackupV4FaultPoint,
  EncryptedBackupV4Limits,
} from "./backup-v4-contracts.js";
import type {
  CanonicalBackupLimits,
  CanonicalBackupManifest,
} from "./backup.js";

/** Result of decrypting and verifying a canonical v3 payload. */
export interface DecryptedBackupPayload {
  readonly parsed: ParsedEncryptedBackupEnvelope;
  readonly payloadPath: string;
  readonly payload: {
    readonly manifest: CanonicalBackupManifest;
    readonly archiveSha256: string;
    readonly archiveBytes: number;
  };
}

type CanonicalBackupVerifier = (
  archivePath: string,
  options?: {
    readonly limits?: Partial<CanonicalBackupLimits>;
  },
) => DecryptedBackupPayload["payload"];

function decryptPayload(
  parsed: ParsedEncryptedBackupEnvelope,
  archivePath: string,
  provider: BackupKeyProvider,
  destination: string,
  fault?: (point: EncryptedBackupV4FaultPoint) => void,
): void {
  fault?.("before-decryption");
  const dataKey = unwrapBackupV4DataKey(parsed.header, provider);
  const temporary = `${destination}.partial-${process.pid}-${crypto.randomUUID()}`;
  const fdIn = fs.openSync(archivePath, "r");
  const fdOut = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    dataKey,
    decodeBackupV4Base64(
      parsed.header.nonce,
      BACKUP_V4_NONCE_BYTES,
      "nonce",
    ),
    { authTagLength: BACKUP_V4_TAG_BYTES },
  );
  decipher.setAAD(parsed.headerRaw);
  decipher.setAuthTag(parsed.tag);
  const hash = crypto.createHash("sha256");
  let position = 0;
  try {
    const input = Buffer.alloc(ENCRYPTED_BACKUP_CHUNK_BYTES);
    while (position < parsed.ciphertextBytes) {
      const count = fs.readSync(
        fdIn,
        input,
        0,
        Math.min(input.length, parsed.ciphertextBytes - position),
        parsed.ciphertextOffset + position,
      );
      if (count === 0) {
        throw new BackupError(
          "backup v4 ciphertext is truncated",
          "backup_v4_archive_truncated",
        );
      }
      position += count;
      const plain = decipher.update(input.subarray(0, count));
      if (plain.length > 0) {
        hash.update(plain);
        fs.writeSync(fdOut, plain);
      }
      fault?.("during-decryption");
    }
    const final = decipher.final();
    if (final.length > 0) {
      hash.update(final);
      fs.writeSync(fdOut, final);
    }
    fs.fsyncSync(fdOut);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      "backup v4 authentication failed",
      "backup_v4_authentication_failed",
      400,
      { cause: error },
    );
  } finally {
    fs.closeSync(fdIn);
    fs.closeSync(fdOut);
  }
  const stats = requireRegularBackupFile(temporary, "backup_v4_payload_invalid");
  if (
    stats.size !== parsed.header.payload_archive_bytes ||
    hash.digest("hex") !== parsed.header.payload_archive_sha256
  ) {
    fs.rmSync(temporary, { force: true });
    throw new BackupError(
      "backup v4 payload integrity failed",
      "backup_v4_payload_integrity",
    );
  }
  fs.renameSync(temporary, destination);
  fault?.("after-decryption");
}

/** Decrypts an envelope and verifies the embedded canonical backup payload. */
export function decryptAndVerify(
  archivePath: string,
  provider: BackupKeyProvider,
  limits: EncryptedBackupV4Limits,
  verifyCanonical: CanonicalBackupVerifier,
  fault?: (point: EncryptedBackupV4FaultPoint) => void,
): DecryptedBackupPayload {
  const parsed = parseEncryptedBackupEnvelope(archivePath, limits);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "prg32-backup-v4-verify-"),
  );
  const payloadPath = path.join(temporaryDirectory, "payload-v3.zip");
  try {
    decryptPayload(parsed, archivePath, provider, payloadPath, fault);
    const payload = verifyCanonical(
      payloadPath,
      limits.canonical === undefined
        ? undefined
        : { limits: limits.canonical },
    );
    if (
      payload.archiveSha256 !== parsed.header.payload_archive_sha256 ||
      payload.manifest.backup_id !== parsed.header.backup_id ||
      payload.manifest.canonical_manifest_sha256 !==
        parsed.header.payload_manifest_sha256
    ) {
      throw new BackupError(
        "backup v4 payload metadata does not match the authenticated header",
        "backup_v4_metadata_mismatch",
      );
    }
    return { parsed, payloadPath, payload };
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}
