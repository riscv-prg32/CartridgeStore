import crypto from "node:crypto";

import { BackupError } from "../backup/format.js";
import {
  DEFAULT_ENCRYPTED_BACKUP_V4_LIMITS,
  ENCRYPTED_BACKUP_V4_ABI,
  ENCRYPTED_BACKUP_V4_AUTHORIZATION,
  ENCRYPTED_BACKUP_V4_OPERATIONAL_AUTHORIZATION,
  ENCRYPTED_BACKUP_V4_VERSION,
  type BackupKeyProvider,
  type BackupKeyRecord,
  type EncryptedBackupV4Header,
  type EncryptedBackupV4Limits,
} from "./backup-v4-contracts.js";
import { TARGET_VERSION_TUPLE } from "./schema.js";

/** Binary size of AES-GCM nonces in the encrypted backup envelope. */
export const BACKUP_V4_NONCE_BYTES = 12;
/** Binary size of AES-256 keys in the encrypted backup envelope. */
export const BACKUP_V4_KEY_BYTES = 32;
/** Binary size of AES-GCM authentication tags in the envelope. */
export const BACKUP_V4_TAG_BYTES = 16;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Checks the stable identifier syntax used by backup key registries. */
export function isBackupV4KeyId(value: string): boolean {
  return KEY_ID_RE.test(value);
}

/** Serializes JSON with recursively sorted object keys. */
export function canonicalBackupJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalBackupJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalBackupJson(item)}`)
    .join(",")}}`;
}

/** Merges and validates encrypted backup resource limits. */
export function encryptedBackupLimits(
  value?: Partial<EncryptedBackupV4Limits>
): EncryptedBackupV4Limits {
  const result = { ...DEFAULT_ENCRYPTED_BACKUP_V4_LIMITS, ...value };
  for (const key of [
    "maxEnvelopeBytes",
    "maxHeaderBytes",
    "maxPayloadBytes",
  ] as const) {
    const numberValue = result[key];
    if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
      throw new BackupError(
        `backup v4 limit ${key} is invalid`,
        "backup_v4_limit_invalid"
      );
    }
  }
  return result;
}

/** Validates the explicit authorization required by encrypted backup writes. */
export function requireEncryptedBackupAuthorization(value: string): void {
  if (
    value !== ENCRYPTED_BACKUP_V4_AUTHORIZATION &&
    value !== ENCRYPTED_BACKUP_V4_OPERATIONAL_AUTHORIZATION
  ) {
    throw new BackupError(
      "explicit encrypted backup authorization is required",
      "backup_v4_authorization_required",
      403
    );
  }
}

/** Decodes a canonical base64url field with an exact binary length. */
export function decodeBackupV4Base64(
  value: string,
  expected: number,
  field: string
): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new BackupError(
      `backup v4 ${field} is invalid`,
      "backup_v4_header_invalid"
    );
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== expected ||
    decoded.toString("base64url") !== value
  ) {
    throw new BackupError(
      `backup v4 ${field} is invalid`,
      "backup_v4_header_invalid"
    );
  }
  return decoded;
}

/** Validates and copies a key record for encryption or decryption. */
export function backupV4Key(
  record: BackupKeyRecord,
  requireActive = false
): Buffer {
  if (
    !KEY_ID_RE.test(record.id) ||
    record.material.byteLength !== BACKUP_V4_KEY_BYTES
  ) {
    throw new BackupError(
      "backup key metadata is invalid",
      "backup_v4_key_registry_invalid"
    );
  }
  if (
    record.status === "retired" ||
    (requireActive && record.status !== "active")
  ) {
    throw new BackupError(
      "backup key is not usable for this operation",
      "backup_v4_key_retired",
      409
    );
  }
  return Buffer.from(record.material);
}

/** Wraps a payload key with the active master key. */
export function wrapBackupV4DataKey(
  dataKey: Buffer,
  master: BackupKeyRecord
): { readonly wrapped: Buffer; readonly nonce: Buffer; readonly tag: Buffer } {
  const nonce = crypto.randomBytes(BACKUP_V4_NONCE_BYTES);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    backupV4Key(master, true),
    nonce,
    { authTagLength: BACKUP_V4_TAG_BYTES }
  );
  const aad = Buffer.from(
    canonicalBackupJson({
      abi: ENCRYPTED_BACKUP_V4_ABI,
      key_id: master.id,
      operation: "wrap-data-key",
    }),
    "utf8"
  );
  cipher.setAAD(aad);
  return {
    wrapped: Buffer.concat([cipher.update(dataKey), cipher.final()]),
    nonce,
    tag: cipher.getAuthTag(),
  };
}

/** Unwraps the payload key after authenticating its master-key envelope. */
export function unwrapBackupV4DataKey(
  header: EncryptedBackupV4Header,
  provider: BackupKeyProvider
): Buffer {
  const record = provider.resolve(header.key_id);
  if (!record) {
    throw new BackupError(
      "required backup key is unavailable",
      "backup_v4_key_unknown",
      409
    );
  }
  const master = backupV4Key(record);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    master,
    decodeBackupV4Base64(
      header.wrap_nonce,
      BACKUP_V4_NONCE_BYTES,
      "wrap nonce"
    ),
    { authTagLength: BACKUP_V4_TAG_BYTES }
  );
  decipher.setAAD(Buffer.from(canonicalBackupJson({
    abi: ENCRYPTED_BACKUP_V4_ABI,
    key_id: header.key_id,
    operation: "wrap-data-key",
  }), "utf8"));
  decipher.setAuthTag(
    decodeBackupV4Base64(header.wrap_tag, BACKUP_V4_TAG_BYTES, "wrap tag")
  );
  try {
    const dataKey = Buffer.concat([
      decipher.update(
        decodeBackupV4Base64(
          header.wrapped_key,
          BACKUP_V4_KEY_BYTES,
          "wrapped key"
        )
      ),
      decipher.final(),
    ]);
    if (dataKey.byteLength !== BACKUP_V4_KEY_BYTES) {
      throw new Error("invalid unwrapped key size");
    }
    return dataKey;
  } catch (error) {
    throw new BackupError(
      "backup key authentication failed",
      "backup_v4_key_authentication_failed",
      400,
      { cause: error }
    );
  }
}

/** Serializes an authenticated encrypted-backup header. */
export function backupV4HeaderBytes(
  header: EncryptedBackupV4Header
): Buffer {
  return Buffer.from(canonicalBackupJson(header), "utf8");
}

/** Parses and validates an authenticated encrypted-backup header. */
export function parseBackupV4Header(
  value: unknown,
  maxHeaderBytes: number
): EncryptedBackupV4Header {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupError(
      "backup v4 header is invalid",
      "backup_v4_header_invalid"
    );
  }
  const header = value as Partial<EncryptedBackupV4Header>;
  if (
    header.abi !== ENCRYPTED_BACKUP_V4_ABI ||
    header.format_version !== ENCRYPTED_BACKUP_V4_VERSION ||
    header.application !== "prg32-cartridge-store" ||
    typeof header.backup_id !== "string" ||
    header.backup_id.length < 1 ||
    header.backup_id.length > 128 ||
    typeof header.created_at !== "string" ||
    header.payload_abi !== "prg32-cartridge-store-backup-3.0" ||
    header.payload_format_version !== 3 ||
    header.versions?.schemaVersion !== TARGET_VERSION_TUPLE.schemaVersion ||
    header.versions?.storageLayoutVersion !== TARGET_VERSION_TUPLE.storageLayoutVersion ||
    header.versions?.publicationJournalVersion !== TARGET_VERSION_TUPLE.publicationJournalVersion ||
    header.versions?.backupFormatVersion !== TARGET_VERSION_TUPLE.backupFormatVersion ||
    typeof header.payload_archive_bytes !== "number" ||
    !Number.isSafeInteger(header.payload_archive_bytes) ||
    header.payload_archive_bytes < 1 ||
    typeof header.payload_archive_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(header.payload_archive_sha256) ||
    typeof header.payload_manifest_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(header.payload_manifest_sha256) ||
    typeof header.key_id !== "string" ||
    !KEY_ID_RE.test(header.key_id) ||
    header.cipher !== "aes-256-gcm" ||
    header.key_wrap !== "aes-256-gcm" ||
    typeof header.nonce !== "string" ||
    typeof header.wrapped_key !== "string" ||
    typeof header.wrap_nonce !== "string" ||
    typeof header.wrap_tag !== "string" ||
    header.tag_bytes !== BACKUP_V4_TAG_BYTES
  ) {
    throw new BackupError(
      "backup v4 header is incompatible",
      "backup_v4_header_invalid"
    );
  }
  const encoded = backupV4HeaderBytes(header as EncryptedBackupV4Header);
  if (encoded.byteLength > maxHeaderBytes) {
    throw new BackupError(
      "backup v4 header is too large",
      "backup_v4_header_too_large"
    );
  }
  decodeBackupV4Base64(header.nonce, BACKUP_V4_NONCE_BYTES, "nonce");
  decodeBackupV4Base64(
    header.wrapped_key,
    BACKUP_V4_KEY_BYTES,
    "wrapped key"
  );
  decodeBackupV4Base64(
    header.wrap_nonce,
    BACKUP_V4_NONCE_BYTES,
    "wrap nonce"
  );
  decodeBackupV4Base64(header.wrap_tag, BACKUP_V4_TAG_BYTES, "wrap tag");
  return header as EncryptedBackupV4Header;
}
