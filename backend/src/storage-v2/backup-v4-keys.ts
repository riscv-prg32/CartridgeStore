import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BackupError } from "../backup/format.js";
import { KeyRegistry, type EncryptionKey } from "../secrets/registry.js";
import {
  BACKUP_V4_KEY_BYTES,
  isBackupV4KeyId,
} from "./backup-v4-codecs.js";
import type {
  BackupKeyProvider,
  BackupKeyRecord,
  BackupKeyRotationOptions,
} from "./backup-v4-contracts.js";

/** Adapter from the encrypted secret registry to the backup key contract. */
export class KeyRegistryBackupKeyProvider implements BackupKeyProvider {
  constructor(private readonly registry: KeyRegistry) {}

  active(): BackupKeyRecord {
    return this.convert(this.registry.active());
  }

  resolve(keyId: string): BackupKeyRecord | undefined {
    if (!this.registry.has(keyId)) return undefined;
    return this.convert(this.registry.require(keyId));
  }

  private convert(key: EncryptionKey): BackupKeyRecord {
    return {
      id: key.id,
      material: Buffer.from(key.material),
      status: key.status,
    };
  }
}

/** Disposable fixture provider used by tests and recovery rehearsals. */
export class InMemoryBackupKeyProvider implements BackupKeyProvider {
  private readonly keys = new Map<string, BackupKeyRecord>();
  private activeId: string;

  constructor(
    records: readonly BackupKeyRecord[],
    activeId?: string,
  ) {
    if (records.length === 0) {
      throw new BackupError(
        "at least one backup key is required",
        "backup_v4_key_registry_invalid",
      );
    }
    for (const record of records) this.add(record);
    this.activeId =
      activeId ?? records.find((record) => record.status === "active")?.id ?? "";
    if (
      !this.activeId ||
      this.keys.get(this.activeId)?.status !== "active"
    ) {
      throw new BackupError(
        "an active backup key is required",
        "backup_v4_active_key_invalid",
      );
    }
  }

  active(): BackupKeyRecord {
    return this.require(this.activeId);
  }

  resolve(keyId: string): BackupKeyRecord | undefined {
    return this.keys.get(keyId);
  }

  rotate(record: BackupKeyRecord): void {
    const current = this.active();
    this.keys.set(current.id, { ...current, status: "decrypt-only" });
    this.add({ ...record, status: "active" });
    this.activeId = record.id;
  }

  retire(keyId: string): void {
    const record = this.require(keyId);
    if (record.id === this.activeId) {
      throw new BackupError(
        "the active backup key cannot be retired",
        "backup_v4_active_key_invalid",
      );
    }
    this.keys.set(keyId, { ...record, status: "retired" });
  }

  private add(record: BackupKeyRecord): void {
    if (
      !isBackupV4KeyId(record.id) ||
      !Buffer.isBuffer(record.material) ||
      record.material.byteLength !== BACKUP_V4_KEY_BYTES ||
      this.keys.has(record.id)
    ) {
      throw new BackupError(
        "backup key metadata is invalid",
        "backup_v4_key_registry_invalid",
      );
    }
    this.keys.set(record.id, {
      ...record,
      material: Buffer.from(record.material),
    });
  }

  private require(keyId: string): BackupKeyRecord {
    const record = this.keys.get(keyId);
    if (!record) {
      throw new BackupError(
        "backup key is unavailable",
        "backup_v4_key_unknown",
      );
    }
    return record;
  }
}

/** Writes a new protected registry; it never overwrites the source registry. */
export function rotateBackupKeyRegistry(
  options: BackupKeyRotationOptions,
): {
  readonly outputPath: string;
  readonly activeKeyId: string;
  readonly retainedKeyIds: readonly string[];
} {
  if (
    !path.isAbsolute(options.inputRegistryPath) ||
    !path.isAbsolute(options.outputRegistryPath) ||
    !isBackupV4KeyId(options.newKeyId)
  ) {
    throw new BackupError(
      "backup key rotation paths or ID are invalid",
      "backup_v4_key_rotation_invalid",
    );
  }
  if (
    path.resolve(options.inputRegistryPath) ===
      path.resolve(options.outputRegistryPath) ||
    fs.existsSync(options.outputRegistryPath)
  ) {
    throw new BackupError(
      "backup key rotation refuses to overwrite a registry",
      "backup_v4_key_rotation_conflict",
      409,
    );
  }
  const current = KeyRegistry.fromFile(options.inputRegistryPath);
  if (current.has(options.newKeyId)) {
    throw new BackupError(
      "backup key rotation ID already exists",
      "backup_v4_key_rotation_conflict",
      409,
    );
  }
  const keys: Array<{
    readonly id: string;
    readonly status: "active" | "decrypt-only";
    readonly key: string;
  }> = current.ids().map((id) => {
    const value = current.require(id);
    return {
      id,
      status: "decrypt-only",
      key: value.material.toString("base64url"),
    };
  });
  keys.push({
    id: options.newKeyId,
    status: "active",
    key: crypto.randomBytes(BACKUP_V4_KEY_BYTES).toString("base64url"),
  });
  fs.mkdirSync(path.dirname(options.outputRegistryPath), {
    recursive: true,
    mode: 0o700,
  });
  const fd = fs.openSync(
    options.outputRegistryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeSync(
      fd,
      `${JSON.stringify(
        { version: 1, active_key_id: options.newKeyId, keys },
        null,
        2,
      )}\n`,
      undefined,
      "utf8",
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return {
    outputPath: options.outputRegistryPath,
    activeKeyId: options.newKeyId,
    retainedKeyIds: current.ids(),
  };
}
