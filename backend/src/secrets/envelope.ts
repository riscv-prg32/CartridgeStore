import crypto from "node:crypto";

import { SecretKeyError, type KeyRegistry } from "./registry.js";

export const ENVELOPE_PREFIX = "prg32enc:v1:";
const ENVELOPE_ROOT_PREFIX = "prg32enc:";
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_MAX_BYTES = 8192;
const CIPHER = "aes-256-gcm";
const KDF = "hkdf-sha256";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PURPOSE_RE = /^(store-setting:[a-z0-9-]{1,96}|federated-provider:[a-z][a-z0-9._-]{0,63}:(oidc-client-secret|saml-sp-signing-private-key|saml-sp-decryption-private-key))$/;

export class SecretEnvelopeError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretEnvelopeError";
  }
}

export interface SecretEnvelope {
  readonly v: 1;
  readonly purpose: string;
  readonly key_id: string;
  readonly kdf: "hkdf-sha256";
  readonly cipher: "aes-256-gcm";
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

function strictBase64Url(value: unknown, field: string, allowEmpty = false): Buffer {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new SecretEnvelopeError("secret_envelope_malformed", `secret envelope ${field} is invalid`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new SecretEnvelopeError("secret_envelope_malformed", `secret envelope ${field} is invalid`);
  return bytes;
}

function aad(settingKey: string, envelope: Pick<SecretEnvelope, "v" | "purpose" | "key_id" | "kdf" | "cipher">): Buffer {
  return Buffer.from(JSON.stringify({
    v: envelope.v,
    purpose: envelope.purpose,
    key_id: envelope.key_id,
    kdf: envelope.kdf,
    cipher: envelope.cipher,
    setting_key: settingKey
  }), "utf8");
}

function derivedKey(root: Buffer, keyId: string, purpose: string): Buffer {
  const info = Buffer.from(`prg32-cartridge-store\0database-secret\0v${ENVELOPE_VERSION}\0${purpose}\0${keyId}`, "utf8");
  const salt = Buffer.from("prg32-cartridge-store/database-secret/hkdf-sha256/v1", "utf8");
  return Buffer.from(crypto.hkdfSync("sha256", root, salt, info, 32));
}

function validatePurpose(settingKey: string, purpose: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(settingKey) || !PURPOSE_RE.test(purpose)) {
    throw new SecretEnvelopeError("secret_envelope_purpose_invalid", "secret envelope purpose is invalid");
  }
}

export function isEncryptedSecret(value: string): boolean { return value.startsWith(ENVELOPE_ROOT_PREFIX); }

export function parseEnvelope(value: string): SecretEnvelope {
  if (!value.startsWith(ENVELOPE_ROOT_PREFIX)) throw new SecretEnvelopeError("secret_plaintext_legacy", "secret setting is legacy plaintext");
  if (!value.startsWith(ENVELOPE_PREFIX)) throw new SecretEnvelopeError("secret_envelope_unsupported_version", "secret envelope version is unsupported");
  if (Buffer.byteLength(value, "utf8") > ENVELOPE_MAX_BYTES) throw new SecretEnvelopeError("secret_envelope_too_large", "secret envelope is too large");
  const encoded = value.slice(ENVELOPE_PREFIX.length);
  const raw = strictBase64Url(encoded, "payload");
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")) as unknown; } catch (error) {
    throw new SecretEnvelopeError("secret_envelope_malformed", "secret envelope is invalid", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new SecretEnvelopeError("secret_envelope_malformed", "secret envelope is invalid");
  const record = parsed as Record<string, unknown>;
  const allowed = ["v", "purpose", "key_id", "kdf", "cipher", "nonce", "ciphertext", "tag"];
  if (Object.keys(record).length !== allowed.length || allowed.some((key) => !Object.hasOwn(record, key))) {
    throw new SecretEnvelopeError("secret_envelope_malformed", "secret envelope fields are invalid");
  }
  if (record.v !== ENVELOPE_VERSION || record.kdf !== KDF || record.cipher !== CIPHER || typeof record.purpose !== "string" || typeof record.key_id !== "string" || !KEY_ID_RE.test(record.key_id) || !PURPOSE_RE.test(record.purpose)) {
    throw new SecretEnvelopeError(record.v !== ENVELOPE_VERSION ? "secret_envelope_unsupported_version" : "secret_envelope_malformed", "secret envelope metadata is invalid");
  }
  const nonce = strictBase64Url(record.nonce, "nonce");
  const ciphertext = strictBase64Url(record.ciphertext, "ciphertext", true);
  const tag = strictBase64Url(record.tag, "tag");
  if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES) throw new SecretEnvelopeError("secret_envelope_malformed", "secret envelope sizes are invalid");
  const envelope = {
    v: 1,
    purpose: record.purpose,
    key_id: record.key_id,
    kdf: "hkdf-sha256",
    cipher: "aes-256-gcm",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url")
  } as const;
  if (Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url") !== encoded) throw new SecretEnvelopeError("secret_envelope_malformed", "secret envelope serialization is not canonical");
  return envelope;
}

export function serializeEnvelope(envelope: SecretEnvelope): string {
  const value = ENVELOPE_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  if (Buffer.byteLength(value, "utf8") > ENVELOPE_MAX_BYTES) throw new SecretEnvelopeError("secret_envelope_too_large", "secret envelope is too large");
  return value;
}

export function encryptSecret(registry: KeyRegistry, settingKey: string, purpose: string, plaintext: string): string {
  validatePurpose(settingKey, purpose);
  const key = registry.active();
  const envelopeBase = { v: 1 as const, purpose, key_id: key.id, kdf: "hkdf-sha256" as const, cipher: "aes-256-gcm" as const };
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, derivedKey(key.material, key.id, purpose), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(settingKey, envelopeBase));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const envelope: SecretEnvelope = { ...envelopeBase, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
  return serializeEnvelope(envelope);
}

export function decryptSecret(registry: KeyRegistry, settingKey: string, purpose: string, encoded: string): string {
  validatePurpose(settingKey, purpose);
  const envelope = parseEnvelope(encoded);
  if (envelope.purpose !== purpose) throw new SecretEnvelopeError("secret_wrong_purpose", "secret envelope purpose does not match");
  let key;
  try { key = registry.require(envelope.key_id); } catch (error) {
    if (error instanceof SecretKeyError) throw error;
    throw new SecretEnvelopeError("secret_key_unknown", "required secret key is unavailable", { cause: error });
  }
  const nonce = Buffer.from(envelope.nonce, "base64url");
  const decipher = crypto.createDecipheriv(CIPHER, derivedKey(key.material, key.id, purpose), nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(settingKey, envelope));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new SecretEnvelopeError("secret_authentication_failed", "secret envelope authentication failed", { cause: error });
  }
}
