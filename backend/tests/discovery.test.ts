import { describe, expect, it } from "vitest";

import { buildDiscoveryContract } from "../src/discovery/contract.js";
import { createDiscoveryService, DiscoveryDependencyError, DiscoveryService } from "../src/discovery/service.js";
import type { DiscoveryTransport } from "../src/discovery/transport.js";
import { buildMdnsRecords, isRelevantDiscoveryQuestion } from "../src/discovery/transport.js";
import { loadConfig } from "../src/config/env.js";
import { buildApp } from "../src/app.js";

class FakeTransport implements DiscoveryTransport {
  starts = 0;
  stops = 0;
  readonly fail: boolean;

  constructor(fail = false) { this.fail = fail; }

  start(): Promise<void> {
    this.starts += 1;
    if (this.fail) return Promise.reject(new Error("synthetic discovery transport failure"));
    return Promise.resolve();
  }

  stop(): Promise<void> { this.stops += 1; return Promise.resolve(); }
}

function contract() {
  return buildDiscoveryContract({
    name: "PRG32 Cartridge Store",
    host: "store.local",
    address: "192.0.2.42",
    port: 5080
  });
}

describe("mDNS discovery contract and lifecycle", () => {
  it("builds the exact source-backed service contract", () => {
    const value = contract();
    expect(value).toEqual({
      abi: "prg32-store-discovery-1.0",
      serviceType: "_prg32store._tcp.local.",
      instanceName: "PRG32 Cartridge Store._prg32store._tcp.local.",
      host: "store.local.",
      address: "192.0.2.42",
      port: 5080,
      txt: ["abi=prg32-store-discovery-1.0"]
    });
    expect(buildMdnsRecords(value)).toEqual({
      answers: [
        { name: "_prg32store._tcp.local.", type: "PTR", ttl: 120, data: "PRG32 Cartridge Store._prg32store._tcp.local." },
        { name: "PRG32 Cartridge Store._prg32store._tcp.local.", type: "SRV", ttl: 120, data: { port: 5080, priority: 0, weight: 0, target: "store.local." } },
        { name: "PRG32 Cartridge Store._prg32store._tcp.local.", type: "TXT", ttl: 120, data: [Buffer.from("abi=prg32-store-discovery-1.0", "utf8")] }
      ],
      additionals: [{ name: "store.local.", type: "A", ttl: 120, data: "192.0.2.42" }]
    });
  });

  it("matches DNS questions with or without the wire-format trailing dot", () => {
    const value = contract();
    expect(isRelevantDiscoveryQuestion(value, value.serviceType)).toBe(true);
    expect(isRelevantDiscoveryQuestion(value, value.serviceType.replace(/\.$/u, ""))).toBe(true);
    expect(isRelevantDiscoveryQuestion(value, "_other._tcp.local.")).toBe(false);
  });

  it("is disabled by default and never constructs a transport", async () => {
    let constructed = 0;
    const service = new DiscoveryService({
      enabled: false,
      contract: contract(),
      transportFactory: () => { constructed += 1; return new FakeTransport(); }
    });
    await service.start();
    await service.stop();
    expect(constructed).toBe(0);
    expect(service.status()).toEqual({ enabled: false, state: "disabled", instance: null });
  });

  it("keeps the real discovery service disabled without loading its optional transport", async () => {
    const service = createDiscoveryService(loadConfig({ PRG32_BACKEND_MDNS_ENABLED: "false" }));
    await service.start();
    await service.stop();
    expect(service.status()).toEqual({ enabled: false, state: "disabled", instance: null });
  });

  it("starts once, rejects duplicate active advertisers, and cleans up", async () => {
    const firstTransport = new FakeTransport();
    const secondTransport = new FakeTransport();
    const first = new DiscoveryService({ enabled: true, contract: contract(), transportFactory: () => firstTransport });
    const second = new DiscoveryService({ enabled: true, contract: contract(), transportFactory: () => secondTransport });
    await first.start();
    await expect(second.start()).rejects.toThrow("already active");
    expect(secondTransport.starts).toBe(0);
    await first.stop();
    await second.start();
    expect(secondTransport.starts).toBe(1);
    await second.stop();
    expect(firstTransport.stops).toBe(1);
    expect(secondTransport.stops).toBe(1);
  });

  it("starts and stops the advertiser when the runtime preference changes", async () => {
    const transport = new FakeTransport();
    const service = new DiscoveryService({ enabled: false, contract: contract(), transportFactory: () => transport });

    await service.setEnabled(true);
    expect(service.status()).toMatchObject({ enabled: true, state: "announced" });
    expect(transport.starts).toBe(1);

    await service.setEnabled(false);
    expect(service.status()).toEqual({ enabled: false, state: "disabled", instance: null });
    expect(transport.stops).toBe(1);
  });

  it("fails closed on transport startup and cleans partial state", async () => {
    const transport = new FakeTransport(true);
    const service = new DiscoveryService({ enabled: true, contract: contract(), transportFactory: () => transport });
    await expect(service.start()).rejects.toThrow("transport failure");
    expect(service.status().state).toBe("degraded");
    expect(transport.stops).toBe(1);
  });

  it("normalizes an isolated missing optional dependency into a controlled startup error", async () => {
    const missing = Object.assign(new Error("Cannot find module 'multicast-dns'"), { code: "MODULE_NOT_FOUND" });
    const service = new DiscoveryService({ enabled: true, contract: contract(), transportFactory: () => Promise.reject(missing) });
    await expect(service.start()).rejects.toBeInstanceOf(DiscoveryDependencyError);
    await expect(service.start()).rejects.toBeInstanceOf(DiscoveryDependencyError);
    expect(service.status().state).toBe("degraded");
  });

  it("rejects unsafe contract values", () => {
    expect(() => buildDiscoveryContract({ name: "bad.name", host: "store.local", address: "192.0.2.42", port: 5080 })).toThrow("service name");
    expect(() => buildDiscoveryContract({ name: "store", host: "store.local", address: "127.0.0.1", port: 5080 })).not.toThrow();
    expect(() => buildDiscoveryContract({ name: "store", host: "store.local", address: "192.0.2.42", port: 0 })).toThrow("port");
    expect(() => buildDiscoveryContract({ name: "store", host: "store.local", address: "192.0.2.999", port: 5080 })).toThrow("IPv4");
  });

  it("requires explicit non-production activation and an interface", () => {
    expect(loadConfig({ PRG32_BACKEND_MDNS_ENABLED: "false" }).mdnsEnabled).toBe(false);
    expect(() => loadConfig({ PRG32_BACKEND_MDNS_ENABLED: "true" })).toThrow("INTERFACE");
    expect(() => loadConfig({ NODE_ENV: "production", PRG32_BACKEND_MDNS_ENABLED: "true", PRG32_BACKEND_MDNS_INTERFACE: "en0" })).toThrow("disabled in production");
  });

  it("fails startup when the explicitly selected discovery interface fails", async () => {
    const app = buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        PRG32_BACKEND_DB: "/does/not/exist/store.sqlite",
        PRG32_BACKEND_MDNS_ENABLED: "true",
        PRG32_BACKEND_MDNS_INTERFACE: "interface-does-not-exist"
      }),
      logger: false
    });
    await expect(app.ready()).rejects.toThrow("mDNS requires a non-loopback IPv4 interface");
    await app.close();
  });
});
