import { publicApiPath } from "./api/origin";

export type ManagedAssetKind = "logo" | "favicon";

export const MANAGED_ASSET_UPDATED_EVENT = "prg32:managed-asset-updated";

export function managedAssetUrl(
  kind: ManagedAssetKind,
  version = Date.now().toString(),
) {
  return publicApiPath(`/api/assets/${kind}?v=${encodeURIComponent(version)}`);
}
