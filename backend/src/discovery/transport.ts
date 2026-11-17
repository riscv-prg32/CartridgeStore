import { createRequire } from "node:module";

import type { DiscoveryContract } from "./contract.js";

export interface DiscoveryTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface MdnsRecord {
  readonly name: string;
  readonly type: "PTR" | "SRV" | "TXT" | "A";
  readonly ttl: number;
  readonly data: unknown;
}

interface MdnsPacket {
  readonly type?: string;
  readonly questions?: readonly { readonly name: string; readonly type: string }[];
}

interface MdnsClient {
  on(event: "query", listener: (packet: MdnsPacket) => void): void;
  on(event: "ready" | "warning", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "ready", listener: () => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  removeListener(event: string, listener: unknown): void;
  respond(packet: { readonly answers: readonly MdnsRecord[]; readonly additionals: readonly MdnsRecord[] }): void;
  send(packet: { readonly answers: readonly MdnsRecord[]; readonly additionals: readonly MdnsRecord[] }, rinfo?: unknown, callback?: () => void): void;
  destroy(callback?: (error?: Error) => void): void;
}

type MdnsFactory = (options: { readonly interface?: string; readonly loopback: boolean }) => MdnsClient;

const require = createRequire(import.meta.url);
const createMdns = require("multicast-dns") as MdnsFactory;

export function buildMdnsRecords(contract: DiscoveryContract, ttl = 120): { readonly answers: MdnsRecord[]; readonly additionals: MdnsRecord[] } {
  const service = contract.serviceType;
  const instance = contract.instanceName;
  const host = contract.host;
  return {
    answers: [
      { name: service, type: "PTR", ttl, data: instance },
      { name: instance, type: "SRV", ttl, data: { port: contract.port, priority: 0, weight: 0, target: host } },
      { name: instance, type: "TXT", ttl, data: contract.txt.map((value) => Buffer.from(value, "utf8")) }
    ],
    additionals: [{ name: host, type: "A", ttl, data: contract.address }]
  };
}

function normalizeDnsName(name: string): string {
  return name.replace(/\.+$/u, "");
}

export function isRelevantDiscoveryQuestion(contract: DiscoveryContract, name: string): boolean {
  const normalizedName = normalizeDnsName(name);
  return normalizedName === normalizeDnsName(contract.serviceType)
    || normalizedName === normalizeDnsName(contract.instanceName)
    || normalizedName === normalizeDnsName(contract.host);
}

function relevant(contract: DiscoveryContract, packet: MdnsPacket): boolean {
  return (packet.questions ?? []).some((question) => {
    return isRelevantDiscoveryQuestion(contract, question.name);
  });
}

export class MulticastDnsTransport implements DiscoveryTransport {
  private client: MdnsClient | null = null;
  private readonly contract: DiscoveryContract;
  private readonly interfaceName: string | undefined;

  constructor(contract: DiscoveryContract, interfaceName?: string) {
    this.contract = contract;
    this.interfaceName = interfaceName;
  }

  start(): Promise<void> {
    const client = createMdns({ ...(this.interfaceName ? { interface: this.interfaceName } : {}), loopback: true });
    this.client = client;
    let ready = false;
    const onQuery = (packet: MdnsPacket) => {
      if (relevant(this.contract, packet)) client.respond(buildMdnsRecords(this.contract, 120));
    };
    client.on("query", onQuery);
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        client.removeListener("error", onError);
        client.removeListener("query", onQuery);
        this.client = null;
        if (!ready) reject(error);
        else client.destroy();
      };
      client.on("error", onError);
      client.once("ready", () => {
        ready = true;
        client.send(buildMdnsRecords(this.contract));
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return Promise.resolve();
    client.send(buildMdnsRecords(this.contract, 0));
    return new Promise((resolve) => client.destroy(() => resolve()));
  }
}
