import os from "node:os";

import type { BackendConfig } from "../config/env.js";
import { buildDiscoveryContract, defaultDiscoveryHost, type DiscoveryContract } from "./contract.js";
import type { DiscoveryTransport } from "./transport.js";

export type DiscoveryState = "disabled" | "idle" | "starting" | "announced" | "degraded" | "stopped";

export interface DiscoveryServiceOptions {
  readonly enabled: boolean;
  readonly contract: DiscoveryContract | (() => DiscoveryContract);
  readonly transportFactory: (contract: DiscoveryContract) => DiscoveryTransport | Promise<DiscoveryTransport>;
}

export class DiscoveryDependencyError extends Error {
  readonly code = "mdns_dependency_unavailable";

  constructor() {
    super("mDNS is enabled but the optional multicast-dns dependency is unavailable; install the locked optional dependency before enabling mDNS");
    this.name = "DiscoveryDependencyError";
  }
}

function isMissingMdnsDependency(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  return candidate.code === "MODULE_NOT_FOUND" && typeof candidate.message === "string" && candidate.message.includes("multicast-dns");
}

async function loadMdnsTransport(contract: DiscoveryContract): Promise<DiscoveryTransport> {
  try {
    const { MulticastDnsTransport } = await import("./transport.js");
    // multicast-dns uses its `interface` option as both the bind address and
    // multicast interface. Binding UDP 5353 directly to the selected address
    // prevents multicast queries from being delivered on Linux/Docker. The
    // contract still advertises the configured interface address; the
    // transport binds all local addresses so the OS can route multicast.
    return new MulticastDnsTransport(contract);
  } catch (error) {
    if (isMissingMdnsDependency(error)) throw new DiscoveryDependencyError();
    throw new Error("mDNS transport could not be loaded");
  }
}

function normalizeDiscoveryStartupError(error: unknown): unknown {
  return isMissingMdnsDependency(error) ? new DiscoveryDependencyError() : error;
}

const activeInstances = new Set<string>();

export class DiscoveryService {
  private enabled: boolean;
  private readonly contractFactory: () => DiscoveryContract;
  private readonly transportFactory: (contract: DiscoveryContract) => DiscoveryTransport | Promise<DiscoveryTransport>;
  private transport: DiscoveryTransport | null = null;
  private state: DiscoveryState;
  private instanceName: string | null = null;

  constructor(options: DiscoveryServiceOptions) {
    this.enabled = options.enabled;
    if (typeof options.contract === "function") this.contractFactory = options.contract;
    else {
      const contract = options.contract;
      this.contractFactory = () => contract;
    }
    this.transportFactory = options.transportFactory;
    this.state = options.enabled ? "idle" : "disabled";
  }

  status(): { readonly enabled: boolean; readonly state: DiscoveryState; readonly instance: string | null } {
    return { enabled: this.enabled, state: this.state, instance: this.instanceName };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      this.enabled = true;
      if (this.state === "disabled" || this.state === "stopped") this.state = "idle";
      await this.start();
      return;
    }

    await this.stop();
    this.enabled = false;
    this.state = "disabled";
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    if (this.state === "announced" || this.state === "starting") return;
    const contract = this.contractFactory();
    if (activeInstances.has(contract.instanceName)) {
      this.state = "degraded";
      throw new Error("mDNS service instance is already active");
    }
    activeInstances.add(contract.instanceName);
    this.instanceName = contract.instanceName;
    this.state = "starting";
    let transport: DiscoveryTransport | null = null;
    try {
      transport = await this.transportFactory(contract);
      this.transport = transport;
      await transport.start();
      this.state = "announced";
    } catch (error) {
      this.transport = null;
      activeInstances.delete(contract.instanceName);
      this.state = "degraded";
      if (transport) {
        try { await transport.stop(); } catch { /* preserve original startup failure */ }
      }
      throw normalizeDiscoveryStartupError(error);
    }
  }

  async stop(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      try { await transport.stop(); } finally {
        if (this.instanceName) activeInstances.delete(this.instanceName);
        this.instanceName = null;
      }
    } else if (this.instanceName) {
      activeInstances.delete(this.instanceName);
      this.instanceName = null;
    }
    if (this.enabled) this.state = "stopped";
  }
}

function localAddress(interfaceName: string): string {
  const interfaces = os.networkInterfaces();
  const names = interfaceName ? [interfaceName] : Object.keys(interfaces);
  for (const name of names) {
    for (const entry of interfaces[name] ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error("mDNS requires a non-loopback IPv4 interface");
}

export function createDiscoveryService(config: BackendConfig, initiallyEnabled = false): DiscoveryService {
  return new DiscoveryService({
    enabled: initiallyEnabled,
    contract: () => buildDiscoveryContract({
      name: config.mdnsName,
      host: config.mdnsHost ?? defaultDiscoveryHost(),
      address: localAddress(config.mdnsInterface),
      port: config.mdnsPort
    }),
    transportFactory: (contract) => loadMdnsTransport(contract)
  });
}
