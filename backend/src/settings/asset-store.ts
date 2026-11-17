import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

import type Database from "better-sqlite3";

import { SettingsError } from "./errors.js";
import {
  detectAssetMime,
  isSafeAssetFilename,
  MAX_ASSET_BYTES,
  type AssetKind,
} from "./assets.js";

interface AssetStoreOptions {
  readonly database: () => Database.Database;
  readonly writableDatabase: Database.Database | null;
  readonly directory: string;
  readonly fault?: (point: "after-asset-publish") => void;
}

interface NormalizedAsset {
  readonly data: Buffer;
  readonly extension: "webp" | "png" | "ico";
  readonly mimeType: "image/webp" | "image/png" | "image/x-icon";
}

/** Resolves and publishes managed logo and favicon files. */
export class SettingsAssetStore {
  private readonly database: () => Database.Database;
  private readonly writable: Database.Database | null;
  private readonly directory: string;
  private readonly fault: AssetStoreOptions["fault"];

  constructor(options: AssetStoreOptions) {
    this.database = options.database;
    this.writable = options.writableDatabase;
    this.directory = options.directory;
    this.fault = options.fault;
  }

  path(kind: AssetKind): {
    readonly path: string;
    readonly extension: string;
    readonly mimeType: string;
  } | null {
    const key = kind === "logo" ? "theme_logo_url" : "theme_favicon_url";
    const stored = this.rawValue(this.database(), key) ?? "";
    const prefix = `/api/assets/${kind}/`;
    if (stored.startsWith(prefix)) {
      const filename = stored.slice(prefix.length);
      if (!isSafeAssetFilename(kind, filename)) return null;
      const resolved = path.resolve(this.directory, filename);
      if (path.dirname(resolved) !== path.resolve(this.directory)) return null;
      const type = filename.endsWith(".png")
        ? "image/png"
        : filename.endsWith(".jpg")
          ? "image/jpeg"
          : filename.endsWith(".webp")
            ? "image/webp"
            : "image/x-icon";
      return {
        path: resolved,
        extension: filename.split(".").pop() ?? "",
        mimeType: type,
      };
    }
    const legacyPrefix = "/static/custom/";
    if (stored.startsWith(legacyPrefix)) {
      const filename = stored.slice(legacyPrefix.length);
      if (!/^[A-Za-z0-9._-]+$/.test(filename)) return null;
      const resolved = path.resolve(this.directory, filename);
      if (path.dirname(resolved) !== path.resolve(this.directory)) return null;
      const type = filename.endsWith(".png")
        ? "image/png"
        : filename.endsWith(".jpg")
          ? "image/jpeg"
          : filename.endsWith(".ico")
            ? "image/x-icon"
            : "application/octet-stream";
      return {
        path: resolved,
        extension: filename.split(".").pop() ?? "",
        mimeType: type,
      };
    }
    return null;
  }

  async replace(
    kind: AssetKind,
    data: Uint8Array,
  ): Promise<{
    readonly kind: AssetKind;
    readonly url: string;
    readonly mime_type: string;
    readonly size: number;
  }> {
    if (!this.writable) {
      throw new SettingsError(
        "settings_unavailable",
        503,
        "settings write isolation is unavailable",
      );
    }
    if (data.byteLength === 0) {
      throw new SettingsError("asset_empty", 400, `${kind} upload is empty`);
    }
    if (data.byteLength > MAX_ASSET_BYTES) {
      throw new SettingsError(
        "asset_too_large",
        413,
        `${kind} upload is too large`,
      );
    }
    const detected = detectAssetMime(kind, data);
    if (!detected) {
      throw new SettingsError(
        "asset_invalid_type",
        400,
        `${kind} must be a valid PNG, JPEG, WebP, or favicon ICO`,
      );
    }
    const normalized = await normalizeAsset(kind, data, detected.extension);
    this.assertRegularDirectory();
    const key = kind === "logo" ? "theme_logo_url" : "theme_favicon_url";
    const previous = this.rawValue(this.writable, key) ?? "";
    const filename = `${kind}-${crypto.randomBytes(16).toString("hex")}.${normalized.extension}`;
    const staging = path.join(this.directory, `.staging-${filename}`);
    const finalPath = path.join(this.directory, filename);
    const url = `/api/assets/${kind}/${filename}`;
    let staged = false;
    let published = false;
    try {
      const fd = fs.openSync(staging, "wx", 0o600);
      try {
        fs.writeFileSync(fd, normalized.data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      staged = true;
      fs.renameSync(staging, finalPath);
      staged = false;
      published = true;
      const directoryFd = fs.openSync(this.directory, "r");
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
      this.fault?.("after-asset-publish");
      this.writable.exec("BEGIN IMMEDIATE");
      this.writable
        .prepare(
          "INSERT INTO store_settings(key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, url);
      this.writable.exec("COMMIT");
      const old = this.pathFromValue(kind, previous);
      if (old && old !== finalPath) {
        try {
          fs.unlinkSync(old);
        } catch {
          // Orphan cleanup is best effort after the active reference is safe.
        }
      }
      return { kind, url, mime_type: normalized.mimeType, size: normalized.data.byteLength };
    } catch (error) {
      if (this.writable.inTransaction) this.writable.exec("ROLLBACK");
      const current = this.rawValue(this.writable, key);
      if (published && current !== url) {
        try {
          fs.unlinkSync(finalPath);
        } catch {
          // Preserve diagnostics without leaking cleanup errors.
        }
      }
      if (staged) {
        try {
          fs.unlinkSync(staging);
        } catch {
          // Cleanup is best effort.
        }
      }
      if (error instanceof SettingsError) throw error;
      throw new SettingsError(
        "asset_publication_failed",
        503,
        `${kind} asset publication failed`,
        { cause: error },
      );
    }
  }

  /** Removes the configured asset and its persisted file, if present. */
  remove(kind: AssetKind): { readonly kind: AssetKind; readonly deleted: boolean } {
    if (!this.writable) {
      throw new SettingsError(
        "settings_unavailable",
        503,
        "settings write isolation is unavailable",
      );
    }
    const key = kind === "logo" ? "theme_logo_url" : "theme_favicon_url";
    const previous = this.rawValue(this.writable, key) ?? "";
    const activePath = this.pathFromValue(kind, previous);
    const hadAsset = Boolean(previous || activePath);

    this.writable.exec("BEGIN IMMEDIATE");
    try {
      this.writable.prepare("DELETE FROM store_settings WHERE key = ?").run(key);
      this.writable.exec("COMMIT");
    } catch (error) {
      if (this.writable.inTransaction) this.writable.exec("ROLLBACK");
      throw new SettingsError(
        "asset_publication_failed",
        503,
        `${kind} asset removal failed`,
        { cause: error },
      );
    }

    if (activePath) {
      try {
        const stats = fs.lstatSync(activePath);
        if (stats.isFile() && !stats.isSymbolicLink()) fs.unlinkSync(activePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new SettingsError(
            "asset_publication_failed",
            503,
            `${kind} asset removal failed`,
            { cause: error },
          );
        }
      }
    }
    return { kind, deleted: hadAsset };
  }

  private rawValue(database: Database.Database, key: string): string | undefined {
    const row = database
      .prepare("SELECT value FROM store_settings WHERE key = ?")
      .get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  }

  private pathFromValue(kind: AssetKind, stored: string): string | null {
    const prefix = `/api/assets/${kind}/`;
    if (stored.startsWith(prefix)) {
      const filename = stored.slice(prefix.length);
      return isSafeAssetFilename(kind, filename)
        ? path.resolve(this.directory, filename)
        : null;
    }
    const legacyPrefix = "/static/custom/";
    if (stored.startsWith(legacyPrefix)) {
      const filename = stored.slice(legacyPrefix.length);
      return /^[A-Za-z0-9._-]+$/.test(filename)
        ? path.resolve(this.directory, filename)
        : null;
    }
    return null;
  }

  private assertRegularDirectory(): void {
    const resolved = path.resolve(this.directory);
    let existing = resolved;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new SettingsError(
          "asset_storage_unavailable",
          503,
          "asset storage is unavailable",
        );
      }
      existing = parent;
    }
    const existingStats = fs.lstatSync(existing);
    if (!existingStats.isDirectory()) {
      throw new SettingsError(
        "asset_storage_unavailable",
        503,
        "asset storage is unavailable",
      );
    }
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(resolved);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SettingsError(
        "asset_storage_unavailable",
        503,
        "asset storage is unavailable",
      );
    }
  }
}

async function normalizeAsset(
  kind: AssetKind,
  data: Uint8Array,
  extension: "png" | "jpg" | "webp" | "ico",
): Promise<NormalizedAsset> {
  // ICO is already the browser-native favicon format. Sharp does not decode
  // every ICO variant reliably, so preserve it rather than rejecting a valid
  // favicon upload.
  if (kind === "favicon" && extension === "ico") {
    return { data: Buffer.from(data), extension: "ico", mimeType: "image/x-icon" };
  }
  try {
    const image = sharp(data, { failOn: "error", limitInputPixels: 40_000_000 });
    const pipeline = kind === "favicon"
      ? image.resize({ width: 512, height: 512, fit: "contain", withoutEnlargement: true, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      : image.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true });
    if (kind === "favicon") {
      const normalized = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      return { data: normalized, extension: "png", mimeType: "image/png" };
    }
    const normalized = await pipeline.webp({ quality: 84, effort: 4 }).toBuffer();
    return { data: normalized, extension: "webp", mimeType: "image/webp" };
  } catch (error) {
    throw new SettingsError("asset_invalid_type", 400, `${kind} could not be decoded as an image`, { cause: error });
  }
}
