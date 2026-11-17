import { SubmissionError } from "./errors.js";

export const METADATA_ABI = "prg32-metadata-1.0";
export const COLOPHON_ABI = "prg32-colophon-1.0";
export const CART_HEADER_SIZE = 72;
export const TRAILER_HEADER_SIZE = 16;
export const TRAILER_MAGIC = Buffer.from("PRG32META", "ascii");
const CART_MAGIC = Buffer.from("PRG2", "ascii");
const AUDIO_MAGIC = Buffer.from("AUD0", "ascii");
const AUDIO_FLAG = 1;

export interface TrailerBlock {
  readonly type: string;
  readonly data: Uint8Array;
}

export interface ParsedCartridge {
  readonly data: Uint8Array;
  readonly legacyPayload: Uint8Array;
  readonly blocks: readonly TrailerBlock[];
  readonly metadata: Record<string, unknown> | null;
  readonly icon: Uint8Array | null;
  readonly screenshot: Uint8Array | null;
  readonly colophon: Record<string, unknown> | null;
}

export const ARCHITECTURES = {
  esp32c6: { id: "esp32c6", label: "ESP32-C6 hardware", platform: "PRG32", target: "esp32c6", display: "ili9341", isa: "RV32I" },
  qemu: { id: "qemu", label: "QEMU virtual screen", platform: "PRG32", target: "esp32c3", display: "qemu-rgb", isa: "RV32I" }
} as const;

function fail(message: string): never {
  throw new SubmissionError(message);
}

function u16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function u32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(message);
  return value as Record<string, unknown>;
}

function jsonObject(data: Uint8Array, name: string): Record<string, unknown> {
  try {
    return object(JSON.parse(Buffer.from(data).toString("utf8")), `${name} block must contain a JSON object`);
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    fail(`${name} block is not valid UTF-8 JSON`);
  }
}

export function normalizeArchitecture(value: unknown): "esp32c6" | "qemu" {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  const aliases: Record<string, "esp32c6" | "qemu"> = {
    "esp32-c6": "esp32c6",
    "riscv-esp32-c6": "esp32c6",
    "risc-v-esp32-c6": "esp32c6",
    hardware: "esp32c6",
    "esp32c3-qemu": "qemu",
    "qemu-rgb": "qemu",
    emulator: "qemu",
    esp32c6: "esp32c6",
    qemu: "qemu"
  };
  const normalized = aliases[key];
  if (!normalized) fail("unsupported architecture");
  return normalized;
}

export function validateMetadata(metadata: Record<string, unknown>): void {
  if (metadata.abi !== METADATA_ABI) fail(`manifest.abi must be ${METADATA_ABI}`);
  for (const field of ["id", "title", "version"]) {
    if (typeof metadata[field] !== "string" || !metadata[field].trim()) fail(`metadata.${field} is required`);
  }
  if (metadata.authors !== undefined && !Array.isArray(metadata.authors)) fail("metadata.authors must be an array");
  if (metadata.tags !== undefined && !Array.isArray(metadata.tags)) fail("metadata.tags must be an array");
  if (metadata.runtime !== undefined && (metadata.runtime === null || typeof metadata.runtime !== "object" || Array.isArray(metadata.runtime))) {
    fail("metadata.runtime must be an object");
  }
}

export function validateColophon(colophon: Record<string, unknown>): void {
  if (colophon.abi !== COLOPHON_ABI) fail(`colophon.abi must be ${COLOPHON_ABI}`);
  for (const field of ["title", "version"]) {
    if (typeof colophon[field] !== "string" || !colophon[field].trim()) fail(`colophon.${field} is required`);
  }
  const developer = colophon.developer;
  if (developer === null || typeof developer !== "object" || Array.isArray(developer)) {
    fail("colophon.developer.name is required");
  }
  const developerName = (developer as Record<string, unknown>).name;
  if (typeof developerName !== "string" || !developerName.trim()) fail("colophon.developer.name is required");
  if (!Array.isArray(colophon.authors)) fail("colophon.authors must be an array");
  if (!Array.isArray(colophon.controls)) fail("colophon.controls must be an array");
}

function legacyPayloadEnd(data: Uint8Array): number {
  if (data.byteLength < CART_HEADER_SIZE) fail("cartridge is smaller than the PRG2 header");
  if (!Buffer.from(data.subarray(0, 4)).equals(CART_MAGIC)) fail("bad cartridge magic");
  const headerSize = u16(data, 8);
  const flags = u16(data, 10);
  const codeSize = u32(data, 16);
  if (headerSize < CART_HEADER_SIZE || headerSize > data.byteLength) fail("invalid cartridge header size");
  if (codeSize === 0 || headerSize + codeSize > data.byteLength) fail("truncated cartridge code payload");
  let end = headerSize + codeSize;
  if ((flags & AUDIO_FLAG) !== 0) {
    if (end + 40 > data.byteLength) fail("truncated cartridge AUDIO block");
    if (!Buffer.from(data.subarray(end, end + 4)).equals(AUDIO_MAGIC)) fail("bad cartridge AUDIO block magic");
    const audioSize = u32(data, end + 36);
    if (audioSize < 40 || end + audioSize > data.byteLength) fail("invalid cartridge AUDIO block length");
    end += audioSize;
  }
  return end;
}

export function parseCartridge(data: Uint8Array): ParsedCartridge {
  const legacyEnd = legacyPayloadEnd(data);
  const remaining = data.subarray(legacyEnd);
  if (remaining.byteLength === 0) return { data, legacyPayload: data, blocks: [], metadata: null, icon: null, screenshot: null, colophon: null };
  if (!Buffer.from(remaining.subarray(0, TRAILER_MAGIC.byteLength)).equals(TRAILER_MAGIC)) {
    return { data, legacyPayload: data, blocks: [], metadata: null, icon: null, screenshot: null, colophon: null };
  }
  if (remaining.byteLength < TRAILER_HEADER_SIZE) fail("truncated metadata trailer header");
  const version = remaining[9];
  const entryCount = u16(remaining, 10);
  const trailerSize = u32(remaining, 12);
  if (version !== 1) fail(`unsupported metadata trailer version ${version}`);
  if (trailerSize < TRAILER_HEADER_SIZE || trailerSize !== remaining.byteLength) fail("invalid metadata trailer length");
  const blocks: TrailerBlock[] = [];
  let offset = TRAILER_HEADER_SIZE;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 8 > trailerSize) fail("truncated metadata TLV header");
    const rawType = remaining.subarray(offset, offset + 4);
    offset += 4;
    const length = u32(remaining, offset);
    offset += 4;
    if (offset + length > trailerSize) fail("metadata TLV length exceeds trailer");
    const type = Buffer.from(rawType).toString("ascii");
    if (!/^[\x20-\x7e]{4}$/.test(type)) fail("metadata TLV type must be ASCII");
    blocks.push({ type, data: remaining.slice(offset, offset + length) });
    offset += length;
  }
  if (offset !== trailerSize) fail("metadata trailer entry count does not match length");
  let metadata: Record<string, unknown> | null = null;
  let icon: Uint8Array | null = null;
  let screenshot: Uint8Array | null = null;
  let colophon: Record<string, unknown> | null = null;
  for (const block of blocks) {
    if (block.type === "META") metadata = jsonObject(block.data, "META");
    if (block.type === "ICON") icon = block.data;
    if (block.type === "SCRN") screenshot = block.data;
    if (block.type === "COLO") colophon = jsonObject(block.data, "COLO");
  }
  if (metadata) validateMetadata(metadata);
  if (colophon) validateColophon(colophon);
  return { data, legacyPayload: data.subarray(0, legacyEnd), blocks, metadata, icon, screenshot, colophon };
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortedJson(item)]));
  }
  return value;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(sortedJson(value)), "utf8");
}

function imageMime(data: Uint8Array): string | null {
  if (Buffer.from(data.subarray(0, 8)).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))) return "image/png";
  if (Buffer.from(data.subarray(0, 3)).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  return null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizedMetadata(metadata: Record<string, unknown>, architecture: "esp32c6" | "qemu", screenshot: Uint8Array | null, colophon: Record<string, unknown> | null): Record<string, unknown> {
  const normalized = cloneJson(metadata);
  delete normalized.assets;
  delete normalized.architectures;
  delete normalized.colophon;
  const runtime = object(normalized.runtime ?? {}, "metadata.runtime must be an object");
  const profile = ARCHITECTURES[architecture];
  runtime.platform ??= profile.platform;
  runtime.isa ??= profile.isa;
  runtime.architecture = architecture;
  runtime.target ??= profile.target;
  runtime.display ??= profile.display;
  const existingArchitectures = Array.isArray(runtime.architectures) ? runtime.architectures : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of existingArchitectures) {
    if (item !== null && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string") {
      byId.set((item as Record<string, unknown>).id as string, cloneJson(item as Record<string, unknown>));
    }
  }
  byId.set(architecture, { ...profile, ...(byId.get(architecture) ?? {}) });
  runtime.architectures = [...byId.keys()].sort().map((key) => byId.get(key) as Record<string, unknown>);
  normalized.runtime = runtime;
  const assets = object(normalized.assets ?? {}, "metadata.assets must be an object");
  assets.icon = { block: "ICON", mime: "image/png" };
  if (screenshot) assets.screenshot = { block: "SCRN", mime: imageMime(screenshot) ?? "image/png", optional: true };
  normalized.assets = assets;
  if (colophon) normalized.colophon = { block: "COLO", abi: COLOPHON_ABI };
  validateMetadata(normalized);
  return normalized;
}

function buildTrailer(blocks: readonly TrailerBlock[]): Uint8Array {
  const encodedLength = blocks.reduce((sum, block) => sum + 8 + block.data.byteLength, 0);
  const output = Buffer.alloc(TRAILER_HEADER_SIZE + encodedLength);
  TRAILER_MAGIC.copy(output, 0);
  output.writeUInt8(1, 9);
  output.writeUInt16LE(blocks.length, 10);
  output.writeUInt32LE(output.byteLength, 12);
  let offset = TRAILER_HEADER_SIZE;
  for (const block of blocks) {
    Buffer.from(block.type, "ascii").copy(output, offset);
    offset += 4;
    output.writeUInt32LE(block.data.byteLength, offset);
    offset += 4;
    Buffer.from(block.data).copy(output, offset);
    offset += block.data.byteLength;
  }
  return output;
}

export function buildSubmissionCartridge(
  legacyBytes: Uint8Array,
  manifest: Record<string, unknown>,
  icon: Uint8Array,
  architecture: "esp32c6" | "qemu",
  screenshot: Uint8Array | null,
  colophon: Record<string, unknown> | null
): Uint8Array {
  const parsed = parseCartridge(legacyBytes);
  const iconType = imageMime(icon);
  if (!iconType) fail("bundle icon must be PNG or JPEG");
  const metadata = normalizedMetadata(manifest, architecture, screenshot, colophon);
  const assets = metadata.assets as Record<string, unknown>;
  (assets.icon as Record<string, unknown>).mime = iconType;
  const blocks: TrailerBlock[] = [
    { type: "META", data: jsonBytes(metadata) },
    { type: "ICON", data: icon }
  ];
  if (screenshot) blocks.push({ type: "SCRN", data: screenshot });
  if (colophon) blocks.push({ type: "COLO", data: jsonBytes(colophon) });
  for (const block of parsed.blocks) {
    if (!["META", "ICON", "SCRN", "COLO"].includes(block.type)) blocks.push(block);
  }
  const result = Buffer.concat([Buffer.from(parsed.legacyPayload), Buffer.from(buildTrailer(blocks))]);
  parseCartridge(result);
  return result;
}

export function validateCartridgeBinary(data: Uint8Array): ParsedCartridge {
  return parseCartridge(data);
}
