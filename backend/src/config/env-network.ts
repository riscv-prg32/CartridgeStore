import {
  booleanValue,
  optionalNonEmpty,
  positiveInteger,
  proxyCidrs,
} from "./env-values.js";

const mdnsProductionMessage = [
  "PRG32_BACKEND_MDNS_ENABLED is disabled in production until the ",
  "advertised endpoint is explicitly reviewed",
].join("");

/** Resolved proxy trust and mDNS network settings. */
export interface NetworkEnvironmentConfig {
  readonly mdnsEnabled: boolean;
  readonly trustProxy: boolean;
  readonly trustProxyHops: number;
  readonly trustedProxyCidrs: readonly string[];
  readonly mdnsInterface: string | undefined;
}

/** Parses and validates proxy trust and mDNS settings. */
export function resolveNetworkConfig(
  environment: NodeJS.ProcessEnv,
): NetworkEnvironmentConfig {
  const mdnsEnabled = booleanValue(
    "PRG32_BACKEND_MDNS_ENABLED",
    environment.PRG32_BACKEND_MDNS_ENABLED,
    false,
  );
  const trustProxy = booleanValue(
    "PRG32_BACKEND_TRUST_PROXY",
    environment.PRG32_BACKEND_TRUST_PROXY,
    false,
  );
  const trustProxyHops = positiveInteger(
    "PRG32_BACKEND_TRUST_PROXY_HOPS",
    environment.PRG32_BACKEND_TRUST_PROXY_HOPS,
    1,
  );
  if (trustProxyHops > 4) {
    throw new Error("PRG32_BACKEND_TRUST_PROXY_HOPS must not exceed 4");
  }
  const trustedProxyCidrs = proxyCidrs(
    environment.PRG32_BACKEND_TRUST_PROXY_CIDRS,
  );
  if (!trustProxy && trustedProxyCidrs.length > 0) {
    throw new Error(
      "PRG32_BACKEND_TRUST_PROXY_CIDRS requires PRG32_BACKEND_TRUST_PROXY=true",
    );
  }
  const mdnsInterface = optionalNonEmpty(
    environment.PRG32_BACKEND_MDNS_INTERFACE,
  );
  if (
    mdnsEnabled &&
    (environment.NODE_ENV ?? "").trim().toLowerCase() === "production"
  ) {
    throw new Error(
      mdnsProductionMessage,
    );
  }
  if (mdnsEnabled && !mdnsInterface) {
    throw new Error(
      "PRG32_BACKEND_MDNS_INTERFACE is required when mDNS is enabled",
    );
  }

  return {
    mdnsEnabled,
    trustProxy,
    trustProxyHops,
    trustedProxyCidrs,
    mdnsInterface,
  };
}
