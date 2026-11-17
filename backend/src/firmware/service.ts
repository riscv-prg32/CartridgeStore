import fs from "node:fs/promises";

import type { BackendConfig } from "../config/env.js";
import { FIRMWARE_MANIFEST_NAME, FirmwareError, type FirmwareManifest, type FirmwareReleaseSummary } from "./contracts.js";
import { sha256Bytes, safeFileName, validateFirmwareManifest } from "./manifest.js";
import { FirmwareSource, MAX_MANIFEST_BYTES } from "./source.js";

export class FirmwareService {
  private readonly source: FirmwareSource;

  constructor(config: BackendConfig, fetcher?: ConstructorParameters<typeof FirmwareSource>[1]) {
    this.source = new FirmwareSource(config, fetcher);
  }

  get repository(): string {
    return this.source.repository;
  }

  async manifest(tag: string): Promise<FirmwareManifest> {
    const release = await this.source.release(tag);
    const location = `${this.source.folder(tag)}/${FIRMWARE_MANIFEST_NAME}`;
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(location);
    } catch {
      const url = release.assets[FIRMWARE_MANIFEST_NAME];
      if (!url) throw new FirmwareError("firmware manifest is unavailable", "upstream_error");
      bytes = await this.source.asset(url, "application/octet-stream", MAX_MANIFEST_BYTES);
      await this.writeCache(location, bytes);
    }
    try { return validateFirmwareManifest(JSON.parse(bytes.toString("utf8")) as unknown); }
    catch (error) { if (error instanceof FirmwareError) throw error; throw new FirmwareError("firmware manifest is invalid", "invalid_manifest"); }
  }

  async part(tag: string, name: string): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
    const manifest = await this.manifest(tag);
    const part = manifest.profiles.flatMap((profile) => profile.parts).find((candidate) => candidate.file === safeFileName(name));
    if (!part) throw new FirmwareError("firmware part not found", "not_found");
    const location = `${this.source.folder(tag)}/${part.file}`;
    let bytes: Uint8Array | null = await fs.readFile(location).catch(() => null);
    if (!bytes || bytes.length !== part.size || sha256Bytes(bytes) !== part.sha256) {
      const release = await this.source.release(tag);
      const url = release.assets[part.file];
      if (!url) throw new FirmwareError(`${part.file} is unavailable`, "upstream_error");
      bytes = await this.source.asset(url, "application/octet-stream", 4 * 1024 * 1024);
      if (bytes.length !== part.size || sha256Bytes(bytes) !== part.sha256) throw new FirmwareError(`${part.file} does not match its manifest`, "integrity_error");
      await this.writeCache(location, bytes);
    }
    if (bytes === null) throw new FirmwareError("firmware part is unavailable", "upstream_error");
    return { bytes: Buffer.from(bytes), sha256: part.sha256 };
  }

  async summaries(): Promise<readonly FirmwareReleaseSummary[]> {
    const result: FirmwareReleaseSummary[] = [];
    for (const tag of await this.releaseTags()) {
      try {
        const release = await this.source.release(tag);
        const manifest = await this.manifest(tag);
        result.push({ tag, name: release.name, published: release.published, prerelease: release.prerelease, version: typeof manifest.version === "string" ? manifest.version : tag, abi: manifest.abi ?? {}, esp_idf: manifest.esp_idf ?? "", preserves: manifest.preserves ?? [], profiles: manifest.profiles.map((profile) => ({ name: profile.name, ...(profile.description === undefined ? {} : { description: profile.description }), ...(profile.warning === undefined ? {} : { warning: profile.warning }) })), manifest_url: `/api/firmware/releases/${encodeURIComponent(tag)}/${FIRMWARE_MANIFEST_NAME}` });
      } catch (error) {
        if (error instanceof FirmwareError) continue;
        throw error;
      }
    }
    return result;
  }

  private async releaseTags(): Promise<readonly string[]> {
    return this.source.tags();
  }

  private async writeCache(location: string, bytes: Uint8Array): Promise<void> {
    await fs.mkdir(location.slice(0, location.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(`${location}.tmp`, bytes);
    await fs.rename(`${location}.tmp`, location);
  }
}
