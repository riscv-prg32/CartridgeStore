import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SECRET_KEY_REGISTRY_VERSION = 1;
export const MAX_KEY_REGISTRY_BYTES = 64 * 1024;
export const MAX_KEY_COUNT = 32;
export const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type KeyStatus = "active" | "decrypt-only";

export interface EncryptionKey {
  readonly id: string;
  readonly status: KeyStatus;
  readonly material: Buffer;
}

export class SecretKeyError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretKeyError";
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SecretKeyError(code, "secret key registry is invalid");
  }
  return value as Record<string, unknown>;
}

function strictBase64Url(value: unknown, code: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new SecretKeyError(code, "secret key material is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || decoded.byteLength !== 32) {
    throw new SecretKeyError(code, "secret key material is invalid");
  }
  return decoded;
}

function assertOutside(root: string | undefined, candidate: string): void {
  if (!root) return;
  let resolvedRoot: string;
  try { resolvedRoot = fs.realpathSync(root); } catch { resolvedRoot = path.resolve(root); }
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new SecretKeyError("secret_key_path_unsafe", "secret key file must be outside application data");
  }
}

function validateRegistry(value: unknown): Map<string, EncryptionKey> {
  const record = object(value, "secret_key_registry_invalid");
  const allowed = new Set(["version", "active_key_id", "keys"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.version !== SECRET_KEY_REGISTRY_VERSION || typeof record.active_key_id !== "string" || !Array.isArray(record.keys)) {
    throw new SecretKeyError("secret_key_registry_invalid", "secret key registry is invalid");
  }
  if (record.keys.length < 1 || record.keys.length > MAX_KEY_COUNT) {
    throw new SecretKeyError("secret_key_registry_invalid", "secret key registry is invalid");
  }
  const keys = new Map<string, EncryptionKey>();
  let activeCount = 0;
  for (const item of record.keys) {
    const key = object(item, "secret_key_registry_invalid");
    const itemKeys = new Set(["id", "status", "key"]);
    if (Object.keys(key).some((name) => !itemKeys.has(name)) || typeof key.id !== "string" || !KEY_ID_RE.test(key.id) || (key.status !== "active" && key.status !== "decrypt-only")) {
      throw new SecretKeyError("secret_key_registry_invalid", "secret key registry is invalid");
    }
    if (keys.has(key.id)) throw new SecretKeyError("secret_key_duplicate_id", "secret key registry contains duplicate key identifiers");
    const material = strictBase64Url(key.key, "secret_key_material_invalid");
    if (key.status === "active") activeCount += 1;
    keys.set(key.id, { id: key.id, status: key.status, material });
  }
  if (typeof record.active_key_id !== "string" || !KEY_ID_RE.test(record.active_key_id) || activeCount !== 1) {
    throw new SecretKeyError("secret_key_active_invalid", "secret key registry must contain exactly one active key");
  }
  const active = keys.get(record.active_key_id);
  if (!active || active.status !== "active") throw new SecretKeyError("secret_key_active_invalid", "active secret key is unavailable");
  return keys;
}

export class KeyRegistry {
  readonly activeKeyId: string;
  private constructor(readonly filePath: string, private readonly keys: Map<string, EncryptionKey>) {
    this.activeKeyId = [...keys.values()].find((key) => key.status === "active")?.id ?? "";
  }

  static fromFile(filePath: string, applicationDataRoot?: string): KeyRegistry {
    if (!path.isAbsolute(filePath)) throw new SecretKeyError("secret_key_path_unsafe", "secret key path must be absolute");
    if (applicationDataRoot) assertOutside(applicationDataRoot, filePath);
    let stats: fs.Stats;
    try { stats = fs.lstatSync(filePath); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "secret_key_file_missing" : "secret_key_file_unavailable";
      throw new SecretKeyError(code, "secret key file is unavailable", { cause: error });
    }
    if (stats.isSymbolicLink() || !stats.isFile()) throw new SecretKeyError("secret_key_path_unsafe", "secret key path is unsafe");
    const canonicalFilePath = path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
    assertOutside(applicationDataRoot, canonicalFilePath);
    if (stats.size <= 0 || stats.size > MAX_KEY_REGISTRY_BYTES) throw new SecretKeyError("secret_key_file_too_large", "secret key file is too large");
    if ((stats.mode & 0o077) !== 0) throw new SecretKeyError("secret_key_permissions", "secret key file permissions are too permissive");
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown; } catch (error) {
      throw new SecretKeyError("secret_key_registry_invalid", "secret key registry is invalid", { cause: error });
    }
    return new KeyRegistry(path.resolve(filePath), validateRegistry(parsed));
  }

  active(): EncryptionKey {
    return this.require(this.activeKeyId);
  }

  require(id: string): EncryptionKey {
    const key = this.keys.get(id);
    if (!key) throw new SecretKeyError("secret_key_unknown", "required secret key is unavailable");
    return key;
  }

  has(id: string): boolean { return this.keys.has(id); }

  ids(): readonly string[] { return [...this.keys.keys()].sort(); }
}

export function generateRegistryDocument(id: string, material = crypto.randomBytes(32)): string {
  if (!KEY_ID_RE.test(id) || material.byteLength !== 32) throw new SecretKeyError("secret_key_material_invalid", "secret key material is invalid");
  return JSON.stringify({
    version: SECRET_KEY_REGISTRY_VERSION,
    active_key_id: id,
    keys: [{ id, status: "active", key: material.toString("base64url") }]
  }, null, 2) + "\n";
}
