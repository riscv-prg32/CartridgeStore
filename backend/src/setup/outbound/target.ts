import dns from "node:dns/promises";
import net from "node:net";

import type { BackendConfig } from "../../config/env.js";
import {
  type Lookup,
  OutboundValidationError,
  type OutboundTargetOptions,
  type ValidatedOutboundTarget,
} from "./types.js";

function mappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase();
  return normalized.startsWith("::ffff:") && net.isIPv4(normalized.slice(7))
    ? normalized.slice(7)
    : null;
}

function ipv4Forbidden(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  const third = parts[2] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && second === 18) ||
    (first === 198 && second === 19) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

/** Returns whether an address is private, reserved, multicast or unspecified. */
export function isForbiddenAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped) return ipv4Forbidden(mapped);
  if (net.isIPv4(address)) return ipv4Forbidden(address);
  const normalized = address.toLowerCase();
  if (!net.isIPv6(normalized)) return true;
  const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    (first >= 0xfc00 && first <= 0xfdff) ||
    (first >= 0xfe80 && first <= 0xfebf) ||
    (first >= 0xff00 && first <= 0xffff) ||
    normalized.startsWith("2001:db8:")
  );
}

function allowlisted(hostname: string, config: BackendConfig): boolean {
  return config.setupNetworkTestAllowlist.includes(hostname.toLowerCase());
}

function portValue(port: number | undefined, fallback: number): number {
  const value = port ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new OutboundValidationError(
      "provider_port_invalid",
      "outbound port is invalid",
    );
  }
  return value;
}

/** Resolves and pins an outbound hostname to a validated address. */
export async function resolveOutboundHost(
  hostnameValue: string,
  port: number | undefined,
  config: BackendConfig,
  options: Pick<OutboundTargetOptions, "lookup" | "defaultPort"> = {},
): Promise<ValidatedOutboundTarget> {
  const hostname = hostnameValue.trim().toLowerCase();
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.includes("/") ||
    hostname.includes("\\") ||
    hostname.includes("@")
  ) {
    throw new OutboundValidationError(
      "provider_host_invalid",
      "outbound host is invalid",
    );
  }
  const resolvedPort = portValue(port, options.defaultPort ?? 443);
  const explicitlyAllowed = allowlisted(hostname, config);
  let addresses: Array<{ address: string; family: number }>;
  try {
    if (net.isIP(hostname)) {
      addresses = [
        { address: hostname, family: net.isIPv4(hostname) ? 4 : 6 },
      ];
    } else {
      const lookup: Lookup =
        options.lookup ??
        ((value, lookupOptions) => dns.lookup(value, lookupOptions));
      addresses = await lookup(hostname, { all: true, verbatim: true });
    }
  } catch {
    throw new OutboundValidationError(
      "provider_dns_failed",
      "outbound host could not be resolved",
    );
  }
  const usable = addresses.filter(
    (item) =>
      (item.family === 4 || item.family === 6) &&
      net.isIP(item.address) === item.family,
  );
  if (usable.length === 0) {
    throw new OutboundValidationError(
      "provider_dns_failed",
      "outbound host could not be resolved",
    );
  }
  if (
    !explicitlyAllowed &&
    usable.some((item) => isForbiddenAddress(item.address))
  ) {
    throw new OutboundValidationError(
      "provider_private_target_denied",
      "outbound target is not allowed",
    );
  }
  const selected = usable[0]!;
  const lookup: net.LookupFunction = (_host, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [
        { address: selected.address, family: selected.family },
      ]);
    } else {
      callback(null, selected.address, selected.family);
    }
  };
  return {
    hostname,
    port: resolvedPort,
    address: selected.address,
    family: selected.family as 4 | 6,
    allowlisted: explicitlyAllowed,
    lookup,
  };
}

/** Validates a provider URL and resolves its network target. */
export async function validateOutboundUrl(
  urlValue: string,
  config: BackendConfig,
  options: OutboundTargetOptions = {},
): Promise<ValidatedOutboundTarget> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new OutboundValidationError(
      "provider_url_invalid",
      "outbound URL is invalid",
    );
  }
  const protocols = options.allowedProtocols ?? ["https:"];
  if (
    !protocols.includes(url.protocol as "http:" | "https:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new OutboundValidationError(
      "provider_https_required",
      "remote provider metadata must use HTTPS",
    );
  }
  const defaultPort =
    options.defaultPort ?? (url.protocol === "https:" ? 443 : 80);
  return resolveOutboundHost(
    url.hostname,
    url.port ? Number(url.port) : defaultPort,
    config,
    options,
  );
}
