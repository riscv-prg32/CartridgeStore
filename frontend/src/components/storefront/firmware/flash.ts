import { ESPLoader, Transport } from "esptool-js";

import { requestApiJson } from "../../../lib/api/client";
import { publicApiPath } from "../../../lib/api/origin";
import type { FirmwareRelease } from "../../../lib/api/firmware";
import { RELEASE_FORMAT, REQUIRED_ROLES, type FlashFile, type FirmwareManifest, type SerialNavigator, USB_FILTER } from "./types";

export function serialAvailable(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && Boolean((navigator as SerialNavigator).serial);
}

function offsetValue(value: string | number): number {
  if (typeof value === "number") return value;
  return /^0x/iu.test(value) ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
}

function hexDigest(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadManifestAndParts(
  release: FirmwareRelease,
  profileName: string,
  setStatus: (message: string) => void,
): Promise<{ manifest: FirmwareManifest; files: FlashFile[] }> {
  const manifest = await requestApiJson(publicApiPath(release.manifest_url), { cache: "no-store" }) as FirmwareManifest;
  if (manifest.format !== RELEASE_FORMAT || manifest.chip !== "esp32c6") throw new Error("This release is not a valid PRG32 ESP32-C6 firmware release.");
  const profile = manifest.profiles.find((item) => item.name === profileName);
  if (!profile || REQUIRED_ROLES.some((role) => !profile.parts.some((part) => part.role === role))) throw new Error("The selected firmware profile is incomplete.");
  const base = release.manifest_url.slice(0, release.manifest_url.lastIndexOf("/") + 1);
  const files: FlashFile[] = [];
  for (const part of [...profile.parts].sort((left, right) => offsetValue(left.offset) - offsetValue(right.offset))) {
    setStatus(`Verifying ${part.role}…`);
    const response = await fetch(publicApiPath(`${base}${encodeURIComponent(part.file)}`), { cache: "no-store" });
    if (!response.ok) throw new Error(`${part.file} could not be downloaded.`);
    const data = new Uint8Array(await response.arrayBuffer());
    const digest = hexDigest(await crypto.subtle.digest("SHA-256", data));
    if (data.length !== part.size || digest !== part.sha256) throw new Error(`${part.file} failed its SHA-256 integrity check.`);
    files.push({ data, address: offsetValue(part.offset), role: part.role });
  }
  return { manifest, files };
}

export async function flashFirmware(options: {
  release: FirmwareRelease;
  profileName: string;
  eraseAll: boolean;
  setStatus: (message: string) => void;
  setProgress: (value: number) => void;
}): Promise<void> {
  const { release, profileName, eraseAll, setStatus, setProgress } = options;
  let transport: Transport | undefined;
  try {
    const port = await (navigator as SerialNavigator).serial?.requestPort({ filters: [USB_FILTER] });
    if (!port) throw new Error("No USB device was selected.");
    const loaded = await loadManifestAndParts(release, profileName, setStatus);
    const total = loaded.files.reduce((sum, file) => sum + file.data.length, 0);
    const before = loaded.files.map((_, index) => loaded.files.slice(0, index).reduce((sum, file) => sum + file.data.length, 0));
    transport = new Transport(port, false);
    const terminal = { clean() {}, writeLine: (text: string) => setStatus(text), write: (text: string) => { if (text.trim()) setStatus(text); } };
    const loader = new ESPLoader({ transport, baudrate: 460800, terminal, debugLogging: false });
    setStatus("Starting the ESP32-C6 bootloader…");
    const chip = await loader.main("default_reset");
    if (!/ESP32-C6/i.test(chip)) throw new Error(`This board is ${chip}, not an ESP32-C6.`);
    if (eraseAll) { setStatus("Erasing the whole flash…"); await loader.eraseFlash(); }
    setStatus("Writing firmware… do not unplug the board.");
    await loader.writeFlash({
      fileArray: loaded.files.map((file) => ({ data: file.data, address: file.address })),
      flashMode: (loaded.manifest.flash?.flash_mode ?? "dio") as "dio",
      flashFreq: (loaded.manifest.flash?.flash_freq ?? "80m") as "80m",
      flashSize: (loaded.manifest.flash?.flash_size ?? "4MB") as "4MB",
      eraseAll: false,
      compress: true,
      reportProgress: (index, written, size) => {
        const file = loaded.files[index];
        if (file) setProgress(Math.round((((before[index] ?? 0) + (written * file.data.length / size)) / total) * 100));
      },
    });
    await loader.after("hard_reset");
    setProgress(100);
    setStatus(`Firmware ${loaded.manifest.version ?? release.version} installed successfully.`);
  } finally {
    if (transport) { try { await transport.disconnect(); } catch { /* USB port is already closed. */ } }
  }
}
