import crypto from "node:crypto";

import {
  FIRMWARE_RELEASE_FORMAT,
  FirmwareError,
  type FirmwareManifest,
  type FirmwarePart,
  type FirmwareProfile,
} from "./contracts.js";

const FILE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*\.bin$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_ROLES = new Set(["bootloader", "partition-table", "app"]);
const MAX_PART_BYTES = 4 * 1024 * 1024;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new FirmwareError(label, "invalid_manifest");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new FirmwareError(label, "invalid_manifest");
  return value;
}

function partOffset(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0x)?[0-9a-f]+$/iu.test(value)) {
    const parsed = Number.parseInt(value, value.toLowerCase().startsWith("0x") ? 16 : 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw new FirmwareError("a firmware part has an invalid flash offset", "invalid_manifest");
}

export function validateFirmwareManifest(value: unknown): FirmwareManifest {
  const manifest = objectValue(value, "firmware manifest is not an object");
  if (manifest.format !== FIRMWARE_RELEASE_FORMAT || manifest.chip !== "esp32c6") throw new FirmwareError("release is not a PRG32 ESP32-C6 firmware manifest", "invalid_manifest");
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0) throw new FirmwareError("firmware release lists no pin profiles", "invalid_manifest");
  const profiles: FirmwareProfile[] = [];
  for (const candidate of manifest.profiles) {
    const profile = objectValue(candidate, "firmware profile is not an object");
    const name = stringValue(profile.name, "firmware profile has no name");
    if (!Array.isArray(profile.parts)) throw new FirmwareError("firmware profile has no parts", "invalid_manifest");
    const parts: FirmwarePart[] = [];
    const roles = new Set<string>();
    for (const candidatePart of profile.parts) {
      const part = objectValue(candidatePart, "firmware part is not an object");
      const role = stringValue(part.role, "firmware part has no role");
      const file = stringValue(part.file, "firmware part has no file");
      const offset = partOffset(part.offset);
      const size = part.size;
      const digest = part.sha256;
      if (!FILE_PATTERN.test(file) || !SHA256_PATTERN.test(String(digest)) || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_PART_BYTES) throw new FirmwareError("firmware part metadata is invalid", "invalid_manifest");
      if ((offset >= 0x9000 && offset < 0x10000) || offset >= 0x210000) throw new FirmwareError("firmware release would overwrite Store data", "unsafe_manifest");
      roles.add(role);
      parts.push({ role, file, offset, size, sha256: String(digest) });
    }
    if (roles.size !== REQUIRED_ROLES.size || [...REQUIRED_ROLES].some((role) => !roles.has(role))) throw new FirmwareError("firmware profile is incomplete", "invalid_manifest");
    profiles.push({ name, ...(typeof profile.description === "string" ? { description: profile.description } : {}), ...(typeof profile.warning === "string" ? { warning: profile.warning } : {}), parts });
  }
  return { ...manifest, format: FIRMWARE_RELEASE_FORMAT, chip: "esp32c6", profiles };
}

export function sha256Bytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function safeFileName(name: string): string {
  if (!FILE_PATTERN.test(name)) throw new FirmwareError("invalid firmware file", "not_found");
  return name;
}
