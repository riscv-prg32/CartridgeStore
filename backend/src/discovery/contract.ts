import os from "node:os";

export const DISCOVERY_SERVICE_TYPE = "_prg32store._tcp.local.";
export const DISCOVERY_ABI = "prg32-store-discovery-1.0";

export interface DiscoveryContract {
  readonly abi: typeof DISCOVERY_ABI;
  readonly serviceType: typeof DISCOVERY_SERVICE_TYPE;
  readonly instanceName: string;
  readonly host: string;
  readonly address: string;
  readonly port: number;
  readonly txt: readonly string[];
}

export interface DiscoveryContractInput {
  readonly name: string;
  readonly host: string;
  readonly address: string;
  readonly port: number;
}

function assertName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 63 || [...normalized].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || normalized.includes(".")) {
    throw new Error("mDNS service name is invalid");
  }
  return normalized;
}

function assertHost(value: string): string {
  const normalized = value.trim().replace(/\.+$/u, "");
  const labels = normalized.split(".");
  if (!normalized || normalized.length > 253 || labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))) {
    throw new Error("mDNS host is invalid");
  }
  return `${normalized}.`;
}

function assertAddress(value: string): string {
  const octets = value.trim().split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet) || Number(octet) > 255)) throw new Error("mDNS IPv4 address is invalid");
  return octets.map((octet) => String(Number(octet))).join(".");
}

function assertPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error("mDNS port is invalid");
  return value;
}

export function defaultDiscoveryHost(): string {
  const hostname = os.hostname().split(".")[0]?.trim() || "prg32-cartridge-store";
  return assertHost(`${hostname}.local`);
}

export function buildDiscoveryContract(input: DiscoveryContractInput): DiscoveryContract {
  const name = assertName(input.name);
  const host = assertHost(input.host);
  const address = assertAddress(input.address);
  const port = assertPort(input.port);
  return {
    abi: DISCOVERY_ABI,
    serviceType: DISCOVERY_SERVICE_TYPE,
    instanceName: `${name}.${DISCOVERY_SERVICE_TYPE}`,
    host,
    address,
    port,
    txt: [`abi=${DISCOVERY_ABI}`]
  };
}
