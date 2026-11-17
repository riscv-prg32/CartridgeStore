import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { unzipSync } from "fflate";
import { CliError } from "./errors.js";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SAFE_ARCHIVE_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CliError("cartridge_manifest_invalid", "manifest.json must be an object", 2);
  return value as Record<string, unknown>;
}

export interface CartridgeValidation {
  readonly file: string;
  readonly bytes: number;
  readonly entries: number;
  readonly id: string;
  readonly version: string;
  readonly architectures: readonly string[];
  readonly manifest_sha256: string;
}

export function validateCartridge(fileName: string): CartridgeValidation {
  const file = path.resolve(fileName);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { throw new CliError("cartridge_unavailable", "cartridge file is unavailable", 2); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CliError("cartridge_path_unsafe", "cartridge path must be a regular file", 2);
  if (stat.size <= 0 || stat.size > MAX_ARCHIVE_BYTES) throw new CliError("cartridge_too_large", "cartridge archive exceeds the CLI limit", 2);
  const data = fs.readFileSync(file);
  assertZipMembers(data);
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(data); } catch { throw new CliError("cartridge_zip_invalid", "cartridge archive is not a valid ZIP", 2); }
  const names = Object.keys(entries);
  if (names.length === 0 || names.length > MAX_ENTRIES) throw new CliError("cartridge_entries_invalid", "cartridge archive entry count is invalid", 2);
  for (const name of names) {
    if (!SAFE_ARCHIVE_PATH.test(name) || name.endsWith("/")) throw new CliError("cartridge_path_unsafe", "cartridge archive contains an unsafe path", 2);
  }
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes || manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new CliError("cartridge_manifest_invalid", "manifest.json is missing or too large", 2);
  let manifest: Record<string, unknown>;
  try { manifest = record(JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown); } catch (error) { if (error instanceof CliError) throw error; throw new CliError("cartridge_manifest_invalid", "manifest.json is invalid", 2); }
  const id = typeof manifest.id === "string" && manifest.id.trim() ? manifest.id.trim() : undefined;
  const version = typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : undefined;
  const architectures = Array.isArray(manifest.architectures) ? manifest.architectures.map((value) => {
    const item = record(value);
    if (typeof item.id !== "string" || !["esp32c6", "qemu"].includes(item.id)) throw new CliError("cartridge_architecture_invalid", "manifest architecture is invalid", 2);
    if (typeof item.file !== "string" || !entries[item.file]) throw new CliError("cartridge_binary_missing", "manifest architecture binary is missing", 2);
    return item.id;
  }) : [];
  if (!id || !version || architectures.length === 0) throw new CliError("cartridge_manifest_invalid", "manifest id, version and architectures are required", 2);
  const hash = awaitHash(manifestBytes);
  return { file, bytes: stat.size, entries: names.length, id, version, architectures, manifest_sha256: hash };
}

function assertZipMembers(data: Uint8Array): void {
  const names = new Set<string>();
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while (offset + 46 <= data.byteLength) {
    const next = Buffer.from(data).indexOf(signature, offset);
    if (next < 0) break;
    const nameLength = (data[next + 28] ?? 0) | ((data[next + 29] ?? 0) << 8);
    const extraLength = (data[next + 30] ?? 0) | ((data[next + 31] ?? 0) << 8);
    const commentLength = (data[next + 32] ?? 0) | ((data[next + 33] ?? 0) << 8);
    const end = next + 46 + nameLength + extraLength + commentLength;
    if (end > data.byteLength) throw new CliError("cartridge_zip_invalid", "cartridge ZIP directory is truncated", 2);
    const name = new TextDecoder().decode(data.subarray(next + 46, next + 46 + nameLength));
    if (names.has(name)) throw new CliError("cartridge_duplicate_entry", "cartridge archive contains duplicate filenames", 2);
    names.add(name);
    const attributes = ((data[next + 38] ?? 0) | ((data[next + 39] ?? 0) << 8)) | (((data[next + 40] ?? 0) | ((data[next + 41] ?? 0) << 8)) << 16);
    const unixType = (attributes >>> 16) & 0xf000;
    if (unixType === 0xa000) throw new CliError("cartridge_symlink", "cartridge archive contains a symlink entry", 2);
    offset = end;
  }
}

function awaitHash(value: Uint8Array): string {
  // The validation path is synchronous so it can be used by CI hooks without a second parser.
  // SHA-256 is computed by the platform after the structural checks complete.
  return crypto.createHash("sha256").update(value).digest("hex");
}
