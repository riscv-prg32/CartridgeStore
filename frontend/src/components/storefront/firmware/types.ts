import type { Transport } from "esptool-js";

export type FirmwarePart = {
  role: string;
  file: string;
  offset: string | number;
  size: number;
  sha256: string;
};

export type FirmwareProfile = {
  name: string;
  description?: string;
  warning?: string;
  parts: FirmwarePart[];
};

export type FirmwareManifest = {
  format: string;
  chip: string;
  version?: string;
  flash?: { flash_mode?: string; flash_freq?: string; flash_size?: string };
  profiles: FirmwareProfile[];
};

export type BrowserSerialPort = ConstructorParameters<typeof Transport>[0];
export type SerialNavigator = Navigator & {
  serial?: {
    requestPort(options?: { filters?: { usbVendorId: number; usbProductId: number }[] }): Promise<BrowserSerialPort>;
  };
};

export type FlashFile = { data: Uint8Array; address: number; role: string };

export const USB_FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };
export const RELEASE_FORMAT = "prg32-firmware-release-1.0";
export const REQUIRED_ROLES = ["bootloader", "partition-table", "app"] as const;
