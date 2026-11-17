export const FIRMWARE_RELEASE_FORMAT = "prg32-firmware-release-1.0";
export const FIRMWARE_MANIFEST_NAME = "prg32-firmware.json";
export const DEFAULT_FIRMWARE_REPOSITORY = "riscv-prg32/PRG32";

export class FirmwareError extends Error {
  constructor(message: string, readonly code = "firmware_error") {
    super(message);
    this.name = "FirmwareError";
  }
}

export type FirmwareFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type FirmwarePart = {
  readonly role: string;
  readonly file: string;
  readonly offset: number;
  readonly size: number;
  readonly sha256: string;
};

export type FirmwareProfile = {
  readonly name: string;
  readonly description?: string;
  readonly warning?: string;
  readonly parts: readonly FirmwarePart[];
};

export type FirmwareManifest = {
  readonly format: typeof FIRMWARE_RELEASE_FORMAT;
  readonly chip: "esp32c6";
  readonly version?: string;
  readonly abi?: Record<string, unknown>;
  readonly esp_idf?: string;
  readonly preserves?: readonly string[];
  readonly flash?: Record<string, unknown>;
  readonly profiles: readonly FirmwareProfile[];
  readonly [key: string]: unknown;
};

export type FirmwareRelease = {
  readonly tag: string;
  readonly name: string;
  readonly published: string;
  readonly prerelease: boolean;
  readonly assets: Readonly<Record<string, string>>;
};

export type FirmwareReleaseSummary = {
  readonly tag: string;
  readonly name: string;
  readonly published: string;
  readonly prerelease: boolean;
  readonly version: string;
  readonly abi: Record<string, unknown>;
  readonly esp_idf: string;
  readonly preserves: readonly string[];
  readonly profiles: readonly Omit<FirmwareProfile, "parts">[];
  readonly manifest_url: string;
};
