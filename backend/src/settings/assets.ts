/** Supported managed application asset kinds. */
export type AssetKind = "logo" | "favicon";

/** Maximum size accepted for a managed application asset. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** Detected format for a managed application asset. */
export interface AssetMime {
  readonly extension: "png" | "jpg" | "webp" | "ico";
  readonly mimeType: string;
}

/** Detects a supported image format from its bounded binary signature. */
export function detectAssetMime(
  kind: AssetKind,
  data: Uint8Array
): AssetMime | null {
  const bytes = Buffer.from(data);
  if (
    bytes.byteLength >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))
  ) {
    let offset = 8;
    let hasHeader = false;
    while (offset + 12 <= bytes.byteLength) {
      const length = bytes.readUInt32BE(offset);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > bytes.byteLength) return null;
      const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      if (!hasHeader) {
        if (
          type !== "IHDR" ||
          length !== 13 ||
          bytes.readUInt32BE(offset + 8) === 0 ||
          bytes.readUInt32BE(offset + 12) === 0
        ) {
          return null;
        }
        hasHeader = true;
      }
      if (type === "IEND") {
        return hasHeader && length === 0 && chunkEnd === bytes.byteLength
          ? { extension: "png", mimeType: "image/png" }
          : null;
      }
      offset = chunkEnd;
    }
    return null;
  }
  if (
    data.byteLength >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff &&
    data[data.byteLength - 2] === 0xff &&
    data[data.byteLength - 1] === 0xd9
  ) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (
    data.byteLength >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return { extension: "webp", mimeType: "image/webp" };
  }
  if (
    kind === "favicon" &&
    data.byteLength >= 6 &&
    data[0] === 0 &&
    data[1] === 0 &&
    data[2] === 1 &&
    data[3] === 0 &&
    (data[4] ?? 0) > 0
  ) {
    return { extension: "ico", mimeType: "image/x-icon" };
  }
  return null;
}

/** Checks the generated filename used by the managed asset endpoint. */
export function isSafeAssetFilename(
  kind: AssetKind,
  filename: string
): boolean {
  return new RegExp(`^${kind}-[a-f0-9]{32}\\.(png|jpg|webp|ico)$`).test(filename);
}
