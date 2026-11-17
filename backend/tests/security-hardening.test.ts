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

describe("bounded rate limiter", () => {
  it("does not evict an active source when high-cardinality keys fill capacity", () => {
    const limiter = new BoundedRateLimiter(1, 10, 2);
    expect(limiter.allow("source-a", 0)).toBe(true);
    expect(limiter.allow("source-b", 0)).toBe(true);
    expect(limiter.allow("source-c", 0)).toBe(false);
    expect(limiter.allow("source-a", 1_000)).toBe(false);
    expect(limiter.allow("source-a", 10_001)).toBe(true);
    expect(limiter.size).toBe(1);
  });
});

describe("WebSocket admission and abuse controls", () => {
  it("enforces global, source and anonymous admission caps with cleanup", async () => {
    const app = await startApp({
      PRG32_BACKEND_MP_MAX_CONNECTIONS: "2",
      PRG32_BACKEND_MP_MAX_CONNECTIONS_PER_SOURCE: "1",
      PRG32_BACKEND_MP_MAX_UNJOINED_CONNECTIONS: "1"
    });
    const first = await openSocket(app);
    const rejected = await openOrClosed(app);
    expect(rejected.code).toBe(1013);
    await closeAndWait(first);
    const afterCleanup = await openSocket(app);
    expect(afterCleanup.readyState).toBe(WebSocket.OPEN);
  });

  it("limits connections per authenticated identity while allowing another identity", async () => {
    const app = await startApp({
      PRG32_USERS: "board:player:board-secret,other:player:other-secret",
      PRG32_BACKEND_MP_MAX_CONNECTIONS_PER_SOURCE: "10",
      PRG32_BACKEND_MP_MAX_CONNECTIONS_PER_IDENTITY: "1"
    });
    const first = await openSocket(app, "board-secret");
    const sameIdentity = await openOrClosed(app, "board-secret");
    expect(sameIdentity.code).toBe(1013);
    const otherIdentity = await openSocket(app, "other-secret");
    expect(otherIdentity.readyState).toBe(WebSocket.OPEN);
    await closeAndWait(first);
  });

  it("keeps normal state traffic compatible and closes sustained message abuse", async () => {
    const app = await startApp({
      PRG32_BACKEND_MP_MESSAGE_RATE: "100",
      PRG32_BACKEND_MP_MESSAGE_BURST: "100",
      PRG32_BACKEND_MP_STATE_RATE: "2",
      PRG32_BACKEND_MP_STATE_BURST: "2"
    });
    const socket = await openSocket(app);
    socket.send(JSON.stringify({ type: "join", signature: "security-room", player_id: 1 }));
    expect(await next(socket)).toMatchObject({ type: "welcome" });
    socket.send(JSON.stringify({ type: "state", x: 1, y: 1, frame: 1 }));
    socket.send(JSON.stringify({ type: "state", x: 2, y: 2, frame: 2 }));
    socket.send(JSON.stringify({ type: "state", x: 3, y: 3, frame: 3 }));
    expect(await waitForClose(socket)).toBe(1008);
  });

  it("limits repeated join attempts without changing the join wire format", async () => {
    const app = await startApp({
      PRG32_BACKEND_MP_JOIN_MAX: "1",
      PRG32_BACKEND_MP_JOIN_WINDOW_SECONDS: "60"
    });
    const socket = await openSocket(app);
    socket.send(JSON.stringify({ type: "join", signature: "join-room", player_id: 1 }));
    expect(await next(socket)).toMatchObject({ type: "welcome" });
    socket.send(JSON.stringify({ type: "join", signature: "join-room-2", player_id: 1 }));
    expect(await waitForClose(socket)).toBe(1008);
  });

  it("expires an unjoined connection and preserves idle joined liveness via ping/pong", async () => {
    const app = await startApp({
      PRG32_BACKEND_MP_HEARTBEAT_INTERVAL_SECONDS: "1",
      PRG32_BACKEND_MP_HEARTBEAT_GRACE_SECONDS: "1",
      PRG32_BACKEND_MP_UNJOINED_TIMEOUT_SECONDS: "1"
    });
    const unjoined = await openSocket(app);
    expect(await waitForClose(unjoined, 4_000)).toBe(1000);

    const joined = await openSocket(app);
    joined.send(JSON.stringify({ type: "join", signature: "idle-room", player_id: 1 }));
    expect(await next(joined)).toMatchObject({ type: "welcome" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(joined.readyState).toBe(WebSocket.OPEN);
  });
});

describe("HTTP limits and proxy attribution", () => {
  it("applies a bounded catalog quota and ignores forged forwarded headers without proxy trust", async () => {
    const app = await startApp({
      PRG32_BACKEND_HTTP_CATALOG_RATE_LIMIT_MAX: "1",
      PRG32_BACKEND_HTTP_RATE_LIMIT_MAX_CLIENTS: "2",
      PRG32_BACKEND_TRUST_PROXY: "false"
    });
    const first = await app.inject({ method: "GET", url: "/api/games", headers: { "x-forwarded-for": "198.51.100.10" } });
    const second = await app.inject({ method: "GET", url: "/api/games", headers: { "x-forwarded-for": "198.51.100.11" } });
    expect(first.statusCode).not.toBe(429);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("rejects proxy CIDRs when proxy trust is disabled", () => {
    expect(() => loadConfig({ PRG32_BACKEND_TRUST_PROXY_CIDRS: "127.0.0.1/32" })).toThrow(/requires PRG32_BACKEND_TRUST_PROXY=true/iu);
    expect(loadConfig({ PRG32_BACKEND_TRUST_PROXY: "true", PRG32_BACKEND_TRUST_PROXY_CIDRS: "127.0.0.1/32" }).trustedProxyCidrs).toEqual(["127.0.0.1/32"]);
  });
});

async function startApp(overrides: Record<string, string> = {}): Promise<ReturnType<typeof buildApp>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m551-"));
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

function wsUrl(app: ReturnType<typeof buildApp>, token?: string): string {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return `ws://127.0.0.1:${address.port}/api/multiplayer${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

async function openSocket(app: ReturnType<typeof buildApp>, token?: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl(app, token));
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function openOrClosed(app: ReturnType<typeof buildApp>, token?: string): Promise<{ code: number }> {
  const socket = new WebSocket(wsUrl(app, token));
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      socket.once("close", (code) => resolve({ code }));
    });
    socket.once("error", () => {
      if (socket.readyState === WebSocket.CLOSED) resolve({ code: 1013 });
      else reject(new Error("unexpected WebSocket error"));
    });
    socket.once("close", (code) => resolve({ code }));
  });
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
      }
      catch (error) { reject(error instanceof Error ? error : new Error("invalid WebSocket JSON")); }
    });
    socket.once("error", reject);
  });
}
