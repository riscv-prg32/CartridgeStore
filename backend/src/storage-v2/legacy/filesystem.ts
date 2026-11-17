import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_MARKER_BYTES,
  type LegacySnapshotConfig,
  type ResolvedLegacySnapshotPaths
} from "./types.js";

export class LegacyFilesystemError extends Error {
  readonly code: string;

  constructor(message: string, code = "legacy_filesystem_invalid", options?: ErrorOptions) {
    super(message, options);
    this.name = "LegacyFilesystemError";
    this.code = code;
  }
}

export interface WalkEntry {
  readonly sourceRef: string;
  readonly absolutePath: string;
  readonly type: "file" | "symlink" | "directory" | "other";
}

export interface HashedFile {
  readonly sourceRef: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly changedDuringScan: boolean;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function asRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function requiredRelative(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || path.isAbsolute(value)) {
    throw new LegacyFilesystemError(`${name} must be a non-empty relative path`, "snapshot_path_invalid");
  }
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized === ".") return "";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("..") || parts.some((part) => part === ".")) {
    throw new LegacyFilesystemError(`${name} contains traversal`, "snapshot_path_unsafe");
  }
  return parts.join("/");
}

function optionalRelative(value: string | null | undefined, name: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredRelative(value, name);
}

function resolveRelative(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !isInside(root, absolute)) {
    throw new LegacyFilesystemError("snapshot path escapes the snapshot root", "snapshot_path_unsafe");
  }
  return absolute;
}

function assertNoSymlinkComponents(root: string, candidate: string): void {
  if (candidate === root) return;
  if (!isInside(root, candidate)) throw new LegacyFilesystemError("snapshot path escapes the snapshot root", "snapshot_path_unsafe");
  let current = root;
  for (const component of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new LegacyFilesystemError("snapshot path contains a symlink", "snapshot_symlink_rejected");
    }
  }
}

function assertDirectory(root: string, candidate: string, required: boolean, label: string): void {
  if (!fs.existsSync(candidate)) {
    if (required) throw new LegacyFilesystemError(`${label} directory is missing`, "snapshot_component_missing");
    return;
  }
  assertNoSymlinkComponents(root, candidate);
  if (!fs.lstatSync(candidate).isDirectory()) throw new LegacyFilesystemError(`${label} is not a directory`, "snapshot_component_invalid");
}

function assertRegularFile(root: string, candidate: string, label: string): void {
  if (!fs.existsSync(candidate)) throw new LegacyFilesystemError(`${label} is missing`, "snapshot_component_missing");
  assertNoSymlinkComponents(root, candidate);
  if (!fs.lstatSync(candidate).isFile()) throw new LegacyFilesystemError(`${label} is not a regular file`, "snapshot_component_invalid");
}

export function resolveLegacySnapshotConfig(config: LegacySnapshotConfig): ResolvedLegacySnapshotPaths {
  if (config === null || typeof config !== "object") throw new LegacyFilesystemError("snapshot configuration is required", "snapshot_config_required");
  if (typeof config.root !== "string" || config.root.trim().length === 0) throw new LegacyFilesystemError("snapshot root is required", "snapshot_root_required");
  const root = path.resolve(config.root);
  if (root === path.parse(root).root) throw new LegacyFilesystemError("filesystem root is not a snapshot", "snapshot_root_unsafe");
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new LegacyFilesystemError("snapshot root must be a real directory", "snapshot_root_invalid");
  }

  const databaseRef = requiredRelative(config.databasePath, "databasePath");
  const catalogRef = requiredRelative(config.catalogPath, "catalogPath");
  const dataRef = requiredRelative(config.dataRoot, "dataRoot");
  const cartridgeRef = requiredRelative(config.cartridgeRoot, "cartridgeRoot");
  const markerRef = requiredRelative(config.preparedMarkerPath, "preparedMarkerPath");
  const submissionRef = optionalRelative(config.submissionRoot, "submissionRoot");
  const mediaRef = optionalRelative(config.mediaRoot, "mediaRoot");
  const paths: ResolvedLegacySnapshotPaths = {
    root,
    databasePath: resolveRelative(root, databaseRef),
    catalogPath: resolveRelative(root, catalogRef),
    dataRoot: resolveRelative(root, dataRef),
    cartridgeRoot: resolveRelative(root, cartridgeRef),
    preparedMarkerPath: resolveRelative(root, markerRef),
    submissionRoot: submissionRef ? resolveRelative(root, submissionRef) : null,
    mediaRoot: mediaRef ? resolveRelative(root, mediaRef) : null
  };
  assertRegularFile(root, paths.databasePath, "legacy database");
  assertRegularFile(root, paths.catalogPath, "legacy catalog");
  assertRegularFile(root, paths.preparedMarkerPath, "snapshot marker");
  assertDirectory(root, paths.dataRoot, true, "data root");
  assertDirectory(root, paths.cartridgeRoot, true, "cartridge root");
  if (paths.submissionRoot) assertDirectory(root, paths.submissionRoot, false, "submission root");
  if (paths.mediaRoot) assertDirectory(root, paths.mediaRoot, false, "media root");
  return paths;
}

export function relativeSourceRef(root: string, absolutePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(absolutePath);
  if (resolvedPath === resolvedRoot) return ".";
  if (!isInside(resolvedRoot, resolvedPath)) throw new LegacyFilesystemError("source reference escapes snapshot root", "snapshot_path_unsafe");
  return asRelative(resolvedRoot, resolvedPath);
}

export function resolveLegacyReference(
  root: string,
  base: string,
  reference: string
): { readonly sourceRef: string; readonly absolutePath: string; readonly safe: boolean } {
  if (typeof reference !== "string" || reference.length === 0 || reference.length > 512 || reference.includes("\0") || reference.includes("\\") || path.isAbsolute(reference)) {
    return { sourceRef: reference, absolutePath: path.resolve(base, "__invalid__"), safe: false };
  }
  const absolutePath = path.resolve(base, reference);
  const safe = isInside(path.resolve(root), absolutePath) && !reference.split("/").includes("..");
  if (!safe) return { sourceRef: reference, absolutePath, safe: false };
  try {
    assertNoSymlinkComponents(path.resolve(root), absolutePath);
  } catch {
    return { sourceRef: relativeSourceRef(path.resolve(root), absolutePath), absolutePath, safe: false };
  }
  return { sourceRef: relativeSourceRef(path.resolve(root), absolutePath), absolutePath, safe: true };
}

export function walkTree(root: string, scanRoot: string): readonly WalkEntry[] {
  if (!fs.existsSync(scanRoot)) return [];
  const entries: WalkEntry[] = [];
  const visit = (directory: string): void => {
    const children = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right));
    for (const name of children) {
      const absolutePath = path.join(directory, name);
      const sourceRef = relativeSourceRef(root, absolutePath);
      const stats = fs.lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        entries.push({ sourceRef, absolutePath, type: "symlink" });
      } else if (stats.isDirectory()) {
        entries.push({ sourceRef, absolutePath, type: "directory" });
        visit(absolutePath);
      } else if (stats.isFile()) {
        entries.push({ sourceRef, absolutePath, type: "file" });
      } else {
        entries.push({ sourceRef, absolutePath, type: "other" });
      }
    }
  };
  visit(scanRoot);
  return entries;
}

export function hashFile(file: WalkEntry | { readonly sourceRef: string; readonly absolutePath: string }): HashedFile {
  const before = fs.statSync(file.absolutePath);
  if (!before.isFile()) throw new LegacyFilesystemError("cannot hash a non-regular file", "legacy_file_invalid");
  const descriptor = fs.openSync(file.absolutePath, fs.constants.O_RDONLY);
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let read: number;
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read > 0) {
        hash.update(buffer.subarray(0, read));
        sizeBytes += read;
      }
    } while (read > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const after = fs.statSync(file.absolutePath);
  return {
    sourceRef: file.sourceRef,
    absolutePath: file.absolutePath,
    sizeBytes,
    sha256: hash.digest("hex"),
    changedDuringScan: before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino
  };
}

export function readBounded(filePath: string, maxBytes: number, label: string): Buffer {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new LegacyFilesystemError(`${label} is not a regular file`, "legacy_file_invalid");
  if (stats.size > maxBytes) throw new LegacyFilesystemError(`${label} exceeds the configured size limit`, "legacy_resource_limit");
  return fs.readFileSync(filePath);
}

function inspectJson(value: unknown, depth: number, nodes: { value: number }): void {
  nodes.value += 1;
  if (nodes.value > MAX_JSON_NODES) throw new LegacyFilesystemError("JSON exceeds the node limit", "legacy_json_limit");
  if (depth > MAX_JSON_DEPTH) throw new LegacyFilesystemError("JSON nesting exceeds the limit", "legacy_json_limit");
  if (Array.isArray(value)) {
    for (const item of value) inspectJson(item, depth + 1, nodes);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) inspectJson(item, depth + 1, nodes);
  }
}

export function parseBoundedJson(filePath: string, maxBytes: number, label: string): unknown {
  return parseBoundedJsonText(readBounded(filePath, maxBytes, label).toString("utf8"), maxBytes, label);
}

export function parseBoundedJsonText(text: string, maxBytes: number, label: string): unknown {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new LegacyFilesystemError(`${label} exceeds the configured size limit`, "legacy_resource_limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof LegacyFilesystemError) throw error;
    throw new LegacyFilesystemError(`${label} is not valid JSON`, "legacy_json_invalid", { cause: error });
  }
  inspectJson(parsed, 0, { value: 0 });
  return parsed;
}

export function parseSnapshotMarker(filePath: string): Readonly<Record<string, unknown>> {
  const parsed = parseBoundedJson(filePath, MAX_MARKER_BYTES, "snapshot marker");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new LegacyFilesystemError("snapshot marker must be an object", "snapshot_marker_invalid");
  const marker = parsed as Record<string, unknown>;
  if (marker.abi !== "prg32-legacy-snapshot-1.0" || marker.state !== "ready") {
    throw new LegacyFilesystemError("snapshot marker is not a ready PRG32 snapshot", "snapshot_marker_invalid");
  }
  return marker;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Bytes(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableFileFingerprint(files: readonly LegacySourceFileLike[]): string {
  return sha256Bytes(canonicalJson(files.map((file) => ({ sourceRef: file.sourceRef, sizeBytes: file.sizeBytes, sha256: file.sha256, kind: file.kind }))));
}

export interface LegacySourceFileLike {
  readonly sourceRef: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly kind: string;
}

export function assertOutputOutsideSnapshot(snapshotRoot: string, outputPath: string): string {
  const root = path.resolve(snapshotRoot);
  const output = path.resolve(outputPath);
  if (output === root || output.startsWith(`${root}${path.sep}`)) throw new LegacyFilesystemError("output path may not be inside the snapshot", "output_path_unsafe");
  return output;
}

export function writeAtomic(outputPath: string, contents: string): void {
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.tmp`);
  fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporaryPath, outputPath);
}
