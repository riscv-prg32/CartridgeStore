import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DISCOVERY_ABI = "prg32-store-discovery-1.0";
export const INDEX_ABI = "prg32-cartridge-store-index-1.0";
export const METADATA_ABI = "prg32-metadata-1.0";
export const COLOPHON_ABI = "prg32-colophon-1.0";
export const CARTRIDGE_MIME = "application/vnd.prg32.cartridge";
export const ROLE_LEVELS = ["reader", "user", "player", "publisher", "admin"] as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const CART_HEADER_SIZE = 72;
const TRAILER_MAGIC = Buffer.from("PRG32META", "ascii");
const TRAILER_HEADER_SIZE = 16;
const AUDIO_BLOCK_MAGIC = Buffer.from("AUD0", "ascii");

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

interface CatalogIndex {
  readonly abi?: unknown;
  readonly games: Record<string, unknown>;
}

export interface ResolvedVariant {
  readonly game: Record<string, unknown>;
  readonly publicGame: Record<string, unknown>;
  readonly variant: Record<string, unknown>;
  readonly architecture: string;
  readonly filePath: string;
  readonly version: string;
}

export interface CartridgeMedia {
  readonly icon: Buffer | null;
  readonly iconMime: string | null;
  readonly screenshot: Buffer | null;
  readonly screenshotMime: string | null;
  readonly colophon: Record<string, unknown> | null;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogError(message);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeValue(value: string, expression: RegExp, label: string): string {
  const candidate = value.trim();
  if (!expression.test(candidate) || candidate.includes("..")) {
    throw new CatalogError(`invalid ${label}`);
  }
  return candidate;
}

export function safeGameId(value: string): string {
  return safeValue(value, SAFE_ID, "game id");
}

export function safeVersion(value: string): string {
  return safeValue(value, SAFE_VERSION, "version");
}

export function normalizeArchitecture(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const key = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    "esp32-c6": "esp32c6",
    "riscv-esp32-c6": "esp32c6",
    "risc-v-esp32-c6": "esp32c6",
    hardware: "esp32c6",
    "esp32c3-qemu": "qemu",
    "qemu-rgb": "qemu",
    emulator: "qemu"
  };
  const normalized = aliases[key] ?? key;
  if (normalized !== "esp32c6" && normalized !== "qemu") {
    throw new CatalogError("unsupported architecture");
  }
  return normalized;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort(compareText);
}

function publicGameRecord(game: Record<string, unknown>, version?: string): Record<string, unknown> {
  const versions = record(game.versions, "invalid versions");
  const latest = stringValue(game.latest_version);
  const selected = version ?? latest;
  const versionRecord = record(versions[selected], "version not found");
  const architectures = record(versionRecord.architectures, "invalid architectures");
  const gameId = stringValue(game.id);
  if (!gameId) throw new CatalogError("game not found");
  return {
    id: gameId,
    title: stringValue(game.title, gameId),
    summary: stringValue(game.summary),
    authors: Array.isArray(game.authors) ? game.authors : [],
    tags: Array.isArray(game.tags) ? game.tags : [],
    latest_version: game.latest_version ?? null,
    selected_version: selected,
    versions: sortedKeys(versions),
    architectures: sortedKeys(architectures),
    metadata: versionRecord.metadata ?? null,
    colophon: versionRecord.colophon ?? null,
    variants: architectures,
    publisher: stringValue(versionRecord.published_by, stringValue(game.publisher)),
    updated_at: game.updated_at ?? null
  };
}

function matchesQuery(game: Record<string, unknown>, needle: string): boolean {
  const values = [
    stringValue(game.id),
    stringValue(game.title),
    stringValue(game.summary),
    ...(Array.isArray(game.tags) ? game.tags.map((tag) => String(tag)) : []),
    ...(Array.isArray(game.authors)
      ? game.authors.map((author) => {
          if (author !== null && typeof author === "object" && !Array.isArray(author)) {
            return stringValue((author as Record<string, unknown>).name);
          }
          return String(author);
        })
      : [])
  ];
  return values.join(" ").toLowerCase().includes(needle);
}

function parseInteger(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function paginateCatalog(items: readonly Record<string, unknown>[], query: Record<string, unknown>): Record<string, unknown> {
  const page = Math.max(parseInteger(query.page, 1), 1);
  const hasPaginationParameter = ["page", "per_page", "limit"].some((key) => Object.hasOwn(query, key));
  const parseOptionalInteger = (value: unknown): number | undefined => {
    if (typeof value !== "string" || !/^-?\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  let perPage = query.per_page === undefined ? undefined : parseOptionalInteger(query.per_page);
  if (perPage === undefined && query.limit !== undefined) {
    perPage = parseOptionalInteger(query.limit);
  }
  if (perPage === undefined) perPage = hasPaginationParameter ? 24 : items.length || 1;
  perPage = Math.min(Math.max(perPage || 1, 1), 100);
  const total = items.length;
  const pages = Math.max(Math.ceil(total / perPage), 1);
  const selectedPage = Math.min(page, pages);
  const start = (selectedPage - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page: selectedPage,
    per_page: perPage,
    total,
    pages,
    has_next: selectedPage < pages,
    has_prev: selectedPage > 1,
    next_page: selectedPage < pages ? selectedPage + 1 : null,
    prev_page: selectedPage > 1 ? selectedPage - 1 : null
  };
}

export class ReadonlyCatalog {
  readonly root: string;

  constructor(dataDirectory: string) {
    this.root = path.resolve(dataDirectory);
  }

  loadIndex(): CatalogIndex {
    const indexPath = path.join(this.root, "index.json");
    if (!fs.existsSync(indexPath)) return { games: {} };
    const safeIndexPath = this.safeExistingPath("index.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(safeIndexPath, "utf8")) as unknown;
    } catch {
      throw new CatalogError("index is not valid JSON");
    }
    const index = record(parsed, "index has an invalid shape");
    return { abi: index.abi, games: record(index.games, "index has an invalid shape") };
  }

  listGames(query?: string): Record<string, unknown>[] {
    const index = this.loadIndex();
    const games = Object.values(index.games).map((value) => publicGameRecord(record(value, "invalid game")));
    const filtered = query?.trim()
      ? games.filter((game) => matchesQuery(game, query.trim().toLowerCase()))
      : games;
    return filtered.sort((left, right) => compareText(stringValue(left.title).toLowerCase(), stringValue(right.title).toLowerCase()));
  }

  publicGame(gameId: string, version?: string): Record<string, unknown> {
    const safeId = safeGameId(gameId);
    const game = record(this.loadIndex().games[safeId], "game not found");
    return publicGameRecord(game, version === undefined ? undefined : safeVersion(version));
  }

  resolveVariant(gameId: string, version?: string, architecture?: string): ResolvedVariant {
    const publicGame = this.publicGame(gameId, version);
    const selectedVersion = stringValue(publicGame.selected_version);
    const variants = record(publicGame.variants, "invalid architectures");
    const selectedArchitecture = normalizeArchitecture(architecture)
      ?? (Object.hasOwn(variants, "esp32c6") ? "esp32c6" : sortedKeys(variants)[0]);
    if (!selectedArchitecture || !Object.hasOwn(variants, selectedArchitecture)) {
      throw new CatalogError("architecture not found");
    }
    const variant = record(variants[selectedArchitecture], "invalid variant");
    const filename = stringValue(variant.filename);
    if (!filename) throw new CatalogError("variant path is invalid");
    const filePath = this.safeExistingPath(filename);
    return {
      game: record(this.loadIndex().games[safeGameId(gameId)], "game not found"),
      publicGame,
      variant,
      architecture: selectedArchitecture,
      filePath,
      version: selectedVersion
    };
  }

  safeExistingPath(filename: string): string {
    const candidate = path.resolve(this.root, filename);
    if (!this.isWithinRoot(candidate)) throw new CatalogError("variant path escapes data directory");
    let realRoot: string;
    let realCandidate: string;
    try {
      realRoot = fs.realpathSync(this.root);
      realCandidate = fs.realpathSync(candidate);
    } catch {
      throw new CatalogError("cartridge file is missing");
    }
    if (!this.isWithinRoot(realCandidate, realRoot) || !fs.statSync(realCandidate).isFile()) {
      throw new CatalogError("variant path escapes data directory");
    }
    return realCandidate;
  }

  private isWithinRoot(candidate: string, root = this.root): boolean {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
  }
}

function assertMetadata(value: Record<string, unknown>): void {
  if (value.abi !== METADATA_ABI || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.version !== "string") {
    throw new CatalogError("invalid cartridge metadata");
  }
}

function assertColophon(value: Record<string, unknown>): void {
  const developer = value.developer;
  if (value.abi !== COLOPHON_ABI || typeof value.title !== "string" || typeof value.version !== "string" || developer === null || typeof developer !== "object" || typeof (developer as Record<string, unknown>).name !== "string" || !Array.isArray(value.authors) || !Array.isArray(value.controls)) {
    throw new CatalogError("invalid cartridge colophon");
  }
}

function parseJsonObject(value: Buffer, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value.toString("utf8")) as unknown, `${label} block is invalid`);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError(`${label} block is invalid`);
  }
}

function detectMime(value: Buffer): string | null {
  if (value.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (value.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  return null;
}

function legacyPayloadEnd(data: Buffer): number {
  if (data.length < CART_HEADER_SIZE || data.subarray(0, 4).toString("ascii") !== "PRG2") {
    throw new CatalogError("invalid cartridge binary");
  }
  const headerSize = data.readUInt16LE(8);
  const flags = data.readUInt16LE(10);
  const codeSize = data.readUInt32LE(16);
  if (headerSize < CART_HEADER_SIZE || headerSize > data.length || codeSize === 0) throw new CatalogError("invalid cartridge binary");
  let end = headerSize + codeSize;
  if (end > data.length) throw new CatalogError("truncated cartridge binary");
  if ((flags & 1) !== 0) {
    if (end + 40 > data.length || !data.subarray(end, end + 4).equals(AUDIO_BLOCK_MAGIC)) throw new CatalogError("invalid cartridge audio block");
    const audioSize = data.readUInt32LE(end + 36);
    if (audioSize < 40 || end + audioSize > data.length) throw new CatalogError("invalid cartridge audio block");
    end += audioSize;
  }
  return end;
}

export function parseCartridgeMedia(data: Buffer): CartridgeMedia {
  const remaining = data.subarray(legacyPayloadEnd(data));
  if (remaining.length === 0 || !remaining.subarray(0, TRAILER_MAGIC.length).equals(TRAILER_MAGIC)) {
    return { icon: null, iconMime: null, screenshot: null, screenshotMime: null, colophon: null };
  }
  if (remaining.length < TRAILER_HEADER_SIZE) throw new CatalogError("truncated metadata trailer");
  const version = remaining.readUInt8(9);
  const entryCount = remaining.readUInt16LE(10);
  const trailerSize = remaining.readUInt32LE(12);
  if (version !== 1 || trailerSize < TRAILER_HEADER_SIZE || trailerSize !== remaining.length) throw new CatalogError("invalid metadata trailer");
  let position = TRAILER_HEADER_SIZE;
  let icon: Buffer | null = null;
  let screenshot: Buffer | null = null;
  let colophon: Record<string, unknown> | null = null;
  for (let index = 0; index < entryCount; index += 1) {
    if (position + 8 > trailerSize) throw new CatalogError("truncated metadata block");
    const type = remaining.subarray(position, position + 4).toString("ascii");
    const length = remaining.readUInt32LE(position + 4);
    position += 8;
    if (length > trailerSize - position) throw new CatalogError("metadata block exceeds trailer");
    const block = Buffer.from(remaining.subarray(position, position + length));
    position += length;
    if (type === "META") {
      const metadata = parseJsonObject(block, "META");
      assertMetadata(metadata);
    } else if (type === "ICON") {
      icon = block;
    } else if (type === "SCRN") {
      screenshot = block;
    } else if (type === "COLO") {
      colophon = parseJsonObject(block, "COLO");
      assertColophon(colophon);
    }
  }
  if (position !== trailerSize) throw new CatalogError("metadata trailer entry count mismatch");
  return {
    icon,
    iconMime: icon ? detectMime(icon) : null,
    screenshot,
    screenshotMime: screenshot ? detectMime(screenshot) : null,
    colophon
  };
}

export function adler32(value: string): number {
  let a = 1;
  let b = 0;
  for (const byte of Buffer.from(value, "utf8")) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function fileEtag(filePath: string, stat: fs.Stats): string {
  const precise = fs.statSync(filePath, { bigint: true });
  const mtime = Number(precise.mtimeNs) / 1_000_000_000;
  return `"${mtime}-${stat.size}-${adler32(filePath)}"`;
}

export function fileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
