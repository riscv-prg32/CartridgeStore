import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { BoundedRateLimiter } from "../src/security/rate-limiter.js";

const sockets: WebSocket[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
  for (const app of apps.splice(0)) await app.close();
});

describe("adversarial regressions", () => {
  it("preserves the firmware-discoverable store API index on both root spellings", async () => {
    const app = await startApp({ PRG32_STORE_NAME: "Disposable Store", PRG32_STORE_VERSION: "2.4.0" });
    for (const url of ["/api", "/api/"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toEqual(expect.objectContaining({
        ok: true,
        service: "Disposable Store",
        version: "2.4.0",
        auth_enabled: true,
        roles: ["reader", "user", "player", "publisher", "admin"],
        mdns: { service: "_prg32store._tcp.local.", name: "Disposable Store" }
      }));
      expect(response.body).toContain("GET /api/games");
      expect(response.body).toContain("GET /api/scores");
      expect(response.body).toContain("POST /api/metrics/batch");
    }
  });

  it("keeps rate-limit capacity bounded and separates clients only behind an explicitly trusted proxy", async () => {
    const limiter = new BoundedRateLimiter(1, 60, 2);
    expect(limiter.allow("shared-nat", 0)).toBe(true);
    expect(limiter.allow("shared-nat", 1)).toBe(false);
    expect(limiter.allow("attacker-1", 1)).toBe(true);
    expect(limiter.allow("attacker-2", 1)).toBe(false);

    const untrusted = await startApp({
      PRG32_BACKEND_HTTP_CATALOG_RATE_LIMIT_MAX: "1",
      PRG32_BACKEND_HTTP_RATE_LIMIT_MAX_CLIENTS: "4",
      PRG32_BACKEND_TRUST_PROXY: "false"
    });
    expect((await untrusted.inject({ method: "GET", url: "/api/games", headers: { "x-forwarded-for": "198.51.100.1" } })).statusCode).not.toBe(429);
    expect((await untrusted.inject({ method: "GET", url: "/api/games", headers: { "x-forwarded-for": "198.51.100.2" } })).statusCode).toBe(429);

    const trusted = await startApp({
      PRG32_BACKEND_HTTP_CATALOG_RATE_LIMIT_MAX: "1",
      PRG32_BACKEND_HTTP_RATE_LIMIT_MAX_CLIENTS: "4",
      PRG32_BACKEND_TRUST_PROXY: "true",
      PRG32_BACKEND_TRUST_PROXY_CIDRS: "127.0.0.1/32"
    });
    expect((await trusted.inject({ method: "GET", url: "/api/games", headers: { "x-forwarded-for": "198.51.100.1" } })).statusCode).not.toBe(429);
    expect((await trusted.inject({ method: "GET", url: "/api/games", headers: { "x-forwarded-for": "198.51.100.2" } })).statusCode).not.toBe(429);
  });

  it("returns stable errors for malformed catalog input without exposing exception text", async () => {
    const app = await startApp();
    const response = await app.inject({ method: "GET", url: "/api/games/unknown-game" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid request", code: "invalid_request" });
    expect(response.body).not.toContain("/tmp/");
    expect(response.body).not.toContain("sqlite");
  });

  it("reclaims every WebSocket admission slot after repeated disconnects", async () => {
    const app = await startApp({
      PRG32_BACKEND_MP_MAX_CONNECTIONS: "1",
      PRG32_BACKEND_MP_MAX_CONNECTIONS_PER_SOURCE: "1",
      PRG32_BACKEND_MP_MAX_UNJOINED_CONNECTIONS: "1"
    });
    for (let index = 0; index < 5; index += 1) {
      const socket = await openSocket(app);
      await closeAndWait(socket);
      const probe = await openSocket(app);
      await closeAndWait(probe);
    }
  });

  it("rejects nested WebSocket payloads and oversized frames without poisoning the next connection", async () => {
    const app = await startApp({ PRG32_BACKEND_MP_MAX_CONNECTIONS: "2" });
    const malformed = await openSocket(app);
    malformed.send(JSON.stringify({ type: "join", signature: "safe-room", metadata: { nested: true } }));
    expect(await next(malformed)).toMatchObject({ type: "error", error: "nested message fields are not allowed" });
    malformed.send(JSON.stringify({ type: "join", signature: "safe-room", player_id: 1 }));
    expect(await next(malformed)).toMatchObject({ type: "welcome" });
    await closeAndWait(malformed);

    const oversized = await openSocket(app);
    oversized.send("x".repeat(70_000));
    expect(await waitForClose(oversized)).toBe(1009);
    const healthy = await openSocket(app);
    healthy.send(JSON.stringify({ type: "join", signature: "healthy-room", player_id: 1 }));
    expect(await next(healthy)).toMatchObject({ type: "welcome" });
  });
});

async function startApp(overrides: Record<string, string> = {}): Promise<ReturnType<typeof buildApp>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m553-"));
  const app = buildApp({
    config: loadConfig({
      PRG32_BACKEND_DB: path.join(root, "shadow.sqlite"),
      PRG32_BACKEND_STORE_DATA: root,
      PRG32_BACKEND_SESSION_SECURE: "false",
      ...overrides
    }),
    logger: false
  });
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  return app;
}

function wsUrl(app: ReturnType<typeof buildApp>): string {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return `ws://127.0.0.1:${address.port}/api/multiplayer`;
}

async function openSocket(app: ReturnType<typeof buildApp>): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl(app));
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function closeAndWait(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

async function waitForClose(socket: WebSocket, timeoutMs = 3_000): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return 1000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket did not close")), timeoutMs);
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function next(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (payload) => {
      try {
        const text = typeof payload === "string"
          ? payload
          : payload instanceof ArrayBuffer
            ? Buffer.from(payload).toString("utf8")
            : Buffer.isBuffer(payload)
              ? payload.toString("utf8")
              : Buffer.concat(payload).toString("utf8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("invalid WebSocket JSON"));
      }
    });
    socket.once("error", reject);
  });
}
