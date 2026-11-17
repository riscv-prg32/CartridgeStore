import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import type { Principal } from "../auth/principal.js";
import { encodePythonJson } from "../compatibility/serialization.js";
import { SubmissionError } from "./errors.js";
import { buildSubmissionCartridge, normalizeArchitecture, validateCartridgeBinary, validateColophon, validateMetadata, COLOPHON_ABI } from "./prg32.js";
import { parseZipArchive, type ZipEntry } from "./zip.js";
import { PendingCartridgeStorage, type PendingStorage, type PendingVariant } from "./storage.js";
import type { RuntimePolicy } from "../settings/runtime-policy.js";

export interface SubmissionResult {
  readonly status: "pending";
  readonly ok: true;
  readonly review_required: true;
  readonly submission_id: number;
  readonly id: string;
  readonly version: string;
  readonly submitted: readonly { architecture: string; file: string }[];
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SubmissionError(message);
  return value as Record<string, unknown>;
}

function clone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function json(value: unknown): string {
  return encodePythonJson(value);
}

function entry(entries: Map<string, ZipEntry>, name: unknown, label: string): ZipEntry {
  if (typeof name !== "string" || !name.trim() || name.endsWith("/")) throw new SubmissionError(`${label} is required`);
  const found = entries.get(name.trim());
  if (!found) throw new SubmissionError(`bundle file is missing: ${name}`);
  return found;
}

function isImage(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, 8)).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary")) ||
    Buffer.from(data.subarray(0, 3)).equals(Buffer.from([0xff, 0xd8, 0xff]));
}

function parseManifest(entries: Map<string, ZipEntry>, config: BackendConfig): Record<string, unknown> {
  const manifestEntry = entry(entries, "manifest.json", "manifest.json");
  if (manifestEntry.data.byteLength > config.submissionMaxManifestBytes) throw new SubmissionError("manifest is too large");
  let manifest: Record<string, unknown>;
  try {
    manifest = record(JSON.parse(Buffer.from(manifestEntry.data).toString("utf8")), "manifest.json must contain a JSON object");
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError("manifest.json must be valid UTF-8 JSON");
  }
  validateMetadata(manifest);
  return manifest;
}

function colophonFromManifest(manifest: Record<string, unknown>): Record<string, unknown> | null {
  const raw = manifest.colophon;
  if (raw === undefined || raw === null) return null;
  const colophon = record(clone(raw), "manifest.colophon must be an object");
  colophon.abi ??= COLOPHON_ABI;
  colophon.title ??= manifest.title;
  colophon.version ??= manifest.version;
  colophon.subtitle ??= typeof colophon.text === "string" ? colophon.text : "";
  if (colophon.developer === undefined) {
    const authors: unknown[] = Array.isArray(manifest.authors) ? manifest.authors as unknown[] : [];
    const first = authors[0];
    colophon.developer = first && typeof first === "object" && !Array.isArray(first) && typeof (first as Record<string, unknown>).name === "string"
      ? { name: (first as Record<string, unknown>).name }
      : { name: "PRG32" };
  }
  colophon.authors ??= Array.isArray(colophon.credits) ? colophon.credits : [];
  colophon.controls ??= [];
  try { validateColophon(colophon); } catch (error) {
    if (error instanceof SubmissionError) throw new SubmissionError("manifest.colophon is invalid");
    throw error;
  }
  return colophon;
}

export interface PreparedSubmissionBundle {
  readonly manifest: Record<string, unknown>;
  readonly variants: readonly PendingVariant[];
}

export function prepareSubmissionBundle(entries: Map<string, ZipEntry>, config: BackendConfig): PreparedSubmissionBundle {
  const manifest = parseManifest(entries, config);
  const assets = record(manifest.assets, "manifest.assets must be an object");
  const iconEntry = entry(entries, assets.icon, "manifest.assets.icon");
  const icon = iconEntry.data;
  if (!isImage(icon)) {
    throw new SubmissionError("bundle icon must be PNG or JPEG");
  }
  let splash: Uint8Array | null = null;
  if (assets.splash) {
    splash = entry(entries, assets.splash, "manifest.assets.splash").data;
    if (!isImage(splash)) {
      throw new SubmissionError("bundle splash must be PNG or JPEG");
    }
  }
  if (!Array.isArray(manifest.architectures) || manifest.architectures.length === 0) throw new SubmissionError("manifest.architectures must be a non-empty array");
  const seen = new Set<string>();
  const variants: PendingVariant[] = [];
  for (const raw of manifest.architectures) {
    const architectureEntry = record(raw, "manifest.architectures entries must be objects");
    const architecture = normalizeArchitecture(architectureEntry.id);
    if (seen.has(architecture)) throw new SubmissionError(`duplicate architecture: ${architecture}`);
    seen.add(architecture);
    if (typeof architectureEntry.file !== "string" || !architectureEntry.file.endsWith(".prg32")) throw new SubmissionError("architecture.file must point to a .prg32 file");
    const binaryEntry = entry(entries, architectureEntry.file, "architecture.file");
    validateCartridgeBinary(binaryEntry.data);
    const image = buildSubmissionCartridge(binaryEntry.data, manifest, icon, architecture, splash, colophonFromManifest(manifest));
    variants.push({ architecture, file: architectureEntry.file, image });
  }
  return { manifest, variants };
}

export interface SubmissionServiceOptions {
  readonly config: BackendConfig;
  readonly database: Database.Database;
  readonly storage?: PendingStorage;
  readonly policy?: RuntimePolicy;
}

export class SubmissionService {
  private readonly storage: PendingStorage;

  constructor(private readonly options: SubmissionServiceOptions) {
    if (!options.config.submissionWriteEnabled || !options.config.submissionDisposableRoot) {
      throw new SubmissionError("publishing write isolation is unavailable", "submission_unavailable", 503);
    }
    this.storage = options.storage ?? new PendingCartridgeStorage(options.config.submissionDisposableRoot);
  }

  createFromBundle(bundle: Uint8Array, principal: Principal): SubmissionResult {
    if (!principal.authenticated || principal.id === null) throw new SubmissionError("login required", "authentication_required", 401);
    if (this.options.policy && !this.options.policy.publishingEnabled()) throw new SubmissionError("publishing is disabled", "invalid_request", 403);
    if (this.options.policy && bundle.byteLength > this.options.policy.maxArtifactBytes()) throw new SubmissionError("bundle upload is too large", "submission_payload_too_large", 413);
    const entries = parseZipArchive(bundle, this.options.config);
    const prepared = prepareSubmissionBundle(entries, this.options.config);
    if (prepared.variants.length === 0) throw new SubmissionError("bundle did not contain any cartridge variants");
    const metadata = clone(prepared.manifest);
    delete metadata.assets;
    delete metadata.architectures;
    delete metadata.colophon;
    metadata.summary ??= "";
    validateMetadata(metadata);
    const db = this.options.database;
    let submissionId = 0;
    try {
      db.exec("BEGIN IMMEDIATE");
      const inserted = db.prepare(
        `INSERT INTO cartridge_submissions(game_id, version, submitted_by_user_id, submitted_by, metadata_json, architectures_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(metadata.id, metadata.version, principal.id, principal.name, json(metadata), "[]");
      submissionId = Number(inserted.lastInsertRowid);
      const staged = this.storage.stage(submissionId, prepared.variants);
      db.prepare("UPDATE cartridge_submissions SET pending_dir = ?, architectures_json = ? WHERE id = ?").run(
        `pending/${submissionId}`,
        json(staged),
        submissionId
      );
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      if (submissionId > 0) {
        try { db.prepare("DELETE FROM cartridge_submissions WHERE id = ?").run(submissionId); } catch { /* best-effort compensation */ }
        try { this.storage.remove(submissionId); } catch { /* best-effort compensation */ }
      }
      if (error instanceof SubmissionError) throw error;
      throw new SubmissionError("submission could not be stored", "submission_storage_failed", 500, { cause: error });
    }
    return {
      status: "pending",
      ok: true,
      review_required: true,
      submission_id: submissionId,
      id: String(metadata.id),
      version: String(metadata.version),
      submitted: prepared.variants.map((variant) => ({ architecture: variant.architecture, file: variant.file }))
    };
  }
}
