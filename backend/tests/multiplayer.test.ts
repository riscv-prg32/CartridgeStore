import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const openSockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
});

describe("Fastify multiplayer WebSocket parity", () => {
  it("serves the compatible info/status routes and relays firmware frames over a real upgrade", async () => {
    const app = buildApp({
      config: loadConfig({
        PRG32_BACKEND_DB: "/does/not/exist/store.sqlite",
        PRG32_USERS: "board:player:board-secret"
      }),
      logger: false
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const info = await fetch(`${baseUrl}/api/multiplayer`);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      ok: true,
      service: "PRG32 multiplayer relay",
      websocket: `ws://127.0.0.1:${address.port}/api/multiplayer`,
      auth_enabled: true
    });

    const first = await connect(`ws://127.0.0.1:${address.port}/api/multiplayer`, { authorization: "Bearer board-secret" });
    const second = await connect(`ws://127.0.0.1:${address.port}/api/multiplayer?token=board-secret`);
    const anonymous = await connect(`ws://127.0.0.1:${address.port}/api/multiplayer`);
    const invalid = await connect(`ws://127.0.0.1:${address.port}/api/multiplayer?token=expired-token`);

    first.send(JSON.stringify({ type: "join", signature: "synthetic-room", token: "board-secret", player_id: 11 }));
    expect(await next(first)).toEqual({ type: "welcome", player_id: 11 });
    second.send(JSON.stringify({ type: "join", signature: "synthetic-room", player_id: 22 }));
    expect(await next(second)).toEqual({ type: "welcome", player_id: 22 });

    first.send(JSON.stringify({ type: "state", x: 10, y: 20, frame: 7 }));
    expect(await next(second)).toEqual({
      type: "peer",
      player_id: 11,
      x: 10,
      y: 20,
      sprite: 0,
      flags: 0,
      input: 0,
      frame: 7
    });

    anonymous.send(JSON.stringify({ type: "join", signature: "synthetic-room" }));
    expect(await next(anonymous)).toMatchObject({ type: "error", error: "player role required" });
    invalid.send(JSON.stringify({ type: "join", signature: "synthetic-room" }));
    expect(await next(invalid)).toMatchObject({ type: "error", error: "player role required" });
    second.send("not-json");
    expect(await next(second)).toEqual({ type: "error", error: "invalid json" });
    second.send(JSON.stringify({ type: "unknown" }));
    expect(await next(second)).toEqual({ type: "error", error: "unknown message type" });
    second.send(JSON.stringify({ type: "leave" }));
    expect(await next(first)).toEqual({ type: "leave", player_id: 22 });

    const status = await fetch(`${baseUrl}/api/multiplayer/status`);
    expect(await status.json()).toEqual({
      ok: true,
      multiplayer: { rooms: { "synthetic-room": 1 }, room_count: 1, max_peers: 8, auth_enabled: true }
    });
    await app.close();
    await closed(first);
    expect(first.readyState).toBe(WebSocket.CLOSED);
  });

  it("keeps rooms isolated and enforces the configured peer cap", async () => {
    const app = buildApp({
      config: loadConfig({
        PRG32_BACKEND_DB: "/does/not/exist/store.sqlite",
        PRG32_MP_MAX_PEERS: "1"
      }),
      logger: false
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
    const first = await connect(`ws://127.0.0.1:${address.port}/api/multiplayer`);
    const second = await connect(`ws://127.0.0.1:${address.port}/api/multiplayer`);
    first.send(JSON.stringify({ type: "join", signature: "room-a", player_id: 1 }));
    expect(await next(first)).toEqual({ type: "welcome", player_id: 1 });
    second.send(JSON.stringify({ type: "join", signature: "room-a", player_id: 2 }));
    expect(await next(second)).toEqual({ type: "error", error: "game room is full" });
    second.send(JSON.stringify({ type: "join", signature: "room-b", player_id: 2 }));
    expect(await next(second)).toEqual({ type: "welcome", player_id: 2 });
    await app.close();
  });
});

async function connect(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  const socket = new WebSocket(url, headers === undefined ? undefined : { headers });
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(asError(error)));
  });
  return socket;
}

async function next(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (payload) => {
      try {
        resolve(JSON.parse(rawDataText(payload)) as Record<string, unknown>);
      } catch (error) {
        reject(asError(error));
      }
    });
    socket.once("error", (error) => reject(asError(error)));
  });
}

async function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

function rawDataText(payload: WebSocket.RawData): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return Buffer.concat(payload).toString("utf8");
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString("utf8");
  return payload.toString("utf8");
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
