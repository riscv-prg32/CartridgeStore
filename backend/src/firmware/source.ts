import fs from "node:fs/promises";
import path from "node:path";

import type { BackendConfig } from "../config/env.js";
import { FIRMWARE_MANIFEST_NAME, FirmwareError, type FirmwareFetcher, type FirmwareRelease } from "./contracts.js";

const TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;
const MAX_RELEASE_LIST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

export class FirmwareSource {
  private readonly cacheDirectory: string;
  private readonly fetcher: FirmwareFetcher;
  private listedAt = 0;
  private listed: Readonly<Record<string, FirmwareRelease>> = {};

  constructor(private readonly config: BackendConfig, fetcher: FirmwareFetcher = globalThis.fetch.bind(globalThis)) {
    this.cacheDirectory = path.join(config.storeDataDirectory, "firmware");
    this.fetcher = fetcher;
  }

  get repository(): string {
    return this.config.firmwareRepository;
  }

  folder(tag: string): string {
    if (!TAG_PATTERN.test(tag)) throw new FirmwareError("invalid firmware release tag", "not_found");
    return path.join(this.config.firmwareDirectory ?? this.cacheDirectory, tag);
  }

  async release(tag: string): Promise<FirmwareRelease> {
    const release = (await this.releases())[tag];
    if (!release || !TAG_PATTERN.test(tag)) throw new FirmwareError("firmware release not found", "not_found");
    return release;
  }

  async tags(): Promise<readonly string[]> {
    return Object.keys(await this.releases());
  }

  async asset(url: string, accept: string, maximum: number): Promise<Buffer> {
    const headers = new Headers({ "user-agent": "prg32-cartridge-store-firmware/1.0", accept });
    if (this.config.firmwareGithubToken && url.startsWith("https://api.github.com/")) headers.set("authorization", `Bearer ${this.config.firmwareGithubToken}`);
    const response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(this.config.firmwareHttpTimeoutMs) });
    if (!response.ok) throw new FirmwareError(`firmware source returned HTTP ${response.status}`, "upstream_error");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximum) throw new FirmwareError("firmware source response is too large", "upstream_error");
    return bytes;
  }

  private async releases(): Promise<Readonly<Record<string, FirmwareRelease>>> {
    const localDirectory = this.config.firmwareDirectory;
    if (localDirectory) {
      const entries = await fs.readdir(localDirectory, { withFileTypes: true }).catch(() => []);
      const result: Record<string, FirmwareRelease> = {};
      for (const entry of entries) {
        if (!entry.isDirectory() || !TAG_PATTERN.test(entry.name)) continue;
        try { await fs.access(path.join(localDirectory, entry.name, FIRMWARE_MANIFEST_NAME)); } catch { continue; }
        result[entry.name] = { tag: entry.name, name: entry.name, published: "", prerelease: false, assets: {} };
      }
      return result;
    }
    if (Object.keys(this.listed).length > 0 && Date.now() - this.listedAt < this.config.firmwareListTtlSeconds * 1000) return this.listed;
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/releases?per_page=30`, { headers: new Headers({ "user-agent": "prg32-cartridge-store-firmware/1.0", accept: "application/vnd.github+json" }), signal: AbortSignal.timeout(this.config.firmwareHttpTimeoutMs) });
    if (!response.ok) throw new FirmwareError(`firmware source returned HTTP ${response.status}`, "upstream_error");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RELEASE_LIST_BYTES) throw new FirmwareError("firmware release list is too large", "upstream_error");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const result: Record<string, FirmwareRelease> = {};
    for (const candidate of Array.isArray(value) ? value : []) {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const release = candidate as Record<string, unknown>;
      const tag = typeof release.tag_name === "string" ? release.tag_name : "";
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const assetMap: Record<string, string> = {};
      for (const asset of assets) {
        if (asset === null || typeof asset !== "object" || Array.isArray(asset)) continue;
        const item = asset as Record<string, unknown>;
        if (typeof item.name === "string" && typeof item.browser_download_url === "string") assetMap[item.name] = item.browser_download_url;
      }
      if (release.draft === true || !TAG_PATTERN.test(tag) || !assetMap[FIRMWARE_MANIFEST_NAME]) continue;
      result[tag] = { tag, name: typeof release.name === "string" && release.name.length > 0 ? release.name : tag, published: typeof release.published_at === "string" ? release.published_at.slice(0, 10) : "", prerelease: release.prerelease === true, assets: assetMap };
    }
    this.listed = result;
    this.listedAt = Date.now();
    return result;
  }
}

export { MAX_MANIFEST_BYTES };
