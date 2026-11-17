import { publicApiPath } from "./origin";
import { requestApiJson } from "./client";

export type FirmwareProfileSummary = {
  name: string;
  description?: string;
  warning?: string;
};

export type FirmwareRelease = {
  tag: string;
  name: string;
  published: string;
  prerelease: boolean;
  version: string;
  abi: Record<string, unknown>;
  esp_idf: string;
  preserves: string[];
  profiles: FirmwareProfileSummary[];
  manifest_url: string;
};

export type FirmwareReleaseList = {
  format: string;
  repository: string;
  releases: FirmwareRelease[];
};

export function firmwareReleaseListPath(): string {
  return publicApiPath("/api/firmware/releases");
}

export async function getFirmwareReleases(): Promise<FirmwareReleaseList> {
  return requestApiJson(firmwareReleaseListPath(), { cache: "no-store" }) as Promise<FirmwareReleaseList>;
}
