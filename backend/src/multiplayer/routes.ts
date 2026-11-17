import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";

import { MultiplayerAdmissionError, type MultiplayerHub, type MultiplayerLimits, type MultiplayerPeer } from "./hub.js";
import { API_V1_BASE_PATH } from "../api/versioning.js";

interface MultiplayerQuery { readonly token?: string }

export interface MultiplayerRouteOptions {
  readonly hub: MultiplayerHub;
  readonly publicOrigin?: string;
  readonly limits: MultiplayerLimits;
  readonly heartbeatIntervalSeconds: number;
  readonly heartbeatGraceSeconds: number;
  readonly unjoinedTimeoutSeconds: number;
}

interface ConnectionState {
  readonly socket: WebSocket;
  readonly peer: MultiplayerPeer;
  readonly createdAt: number;
  isAlive: boolean;
  pongDeadlineAt: number | null;
  nextPingAt: number;
}

export function registerMultiplayerRoutes(app: FastifyInstance, options: MultiplayerRouteOptions): void {
  app.register((scope) => {
    scope.register(websocket, { options: { maxPayload: options.limits.maxMessageBytes } });
    scope.register((routes) => {
      const connections = new Map<WebSocket, ConnectionState>();
      const heartbeatTickMs = Math.max(250, Math.min(1000, options.heartbeatGraceSeconds * 1000 / 2));
      const heartbeatTimer = setInterval(() => {
        const now = Date.now();
        for (const state of connections.values()) {
          if (!state.peer.joinedOnce && now - state.createdAt >= options.unjoinedTimeoutSeconds * 1000) {
            closeSocket(state.socket, 1000, "join timeout");
            continue;
          }
          if (state.pongDeadlineAt !== null && now >= state.pongDeadlineAt) {
            state.peer.closeConnection(1001, "pong timeout");
            continue;
          }
          if (now >= state.nextPingAt) {
            state.isAlive = false;
            state.pongDeadlineAt = now + options.heartbeatGraceSeconds * 1000;
            state.nextPingAt = now + options.heartbeatIntervalSeconds * 1000;
            try { state.socket.ping(); } catch { closeSocket(state.socket, 1001, "heartbeat failed"); }
          }
        }
      }, heartbeatTickMs);
      heartbeatTimer.unref?.();

      routes.addHook("onClose", () => {
        clearInterval(heartbeatTimer);
        for (const state of connections.values()) closeSocket(state.socket, 1001, "server shutting down");
        connections.clear();
        options.hub.close();
      });

      routes.get("/api/multiplayer/status", (_request, reply) => reply.send({ ok: true, multiplayer: options.hub.status() }));

      routes.route<{ Querystring: MultiplayerQuery }>({
        method: "GET",
        url: "/api/multiplayer",
        handler: (request, reply) => {
          const originalUrl = (request.raw as typeof request.raw & { originalUrl?: string }).originalUrl ?? request.url;
          const endpoint = originalUrl.split("?", 1)[0]?.startsWith(`${API_V1_BASE_PATH}/`) ? `${API_V1_BASE_PATH}/multiplayer` : "/api/multiplayer";
          const configuredOrigin = options.publicOrigin ? new URL(options.publicOrigin) : null;
          const scheme = configuredOrigin ? (configuredOrigin.protocol === "https:" ? "wss" : "ws") : (request.protocol === "https" ? "wss" : "ws");
          const host = configuredOrigin?.host ?? request.headers.host ?? "localhost";
          return reply.send({
            ok: true,
            service: "PRG32 multiplayer relay",
            websocket: `${scheme}://${host}${endpoint}`,
            auth_enabled: options.hub.authenticationEnabled,
            protocol: {
              join: { type: "join", signature: "game-v1", player_id: 1 },
              state: { type: "state", x: 0, y: 0, frame: 0 },
              leave: { type: "leave" }
            }
          });
        },
        wsHandler: (socket, request) => {
          const connectionToken = tokenFromRequest(request);
          let peer: MultiplayerPeer;
          try {
            peer = options.hub.connect(
              (message) => sendBoundedJson(socket, message, options.limits),
              connectionToken,
              request.ip || "unknown",
              (code, reason) => closeSocket(socket, code, reason)
            );
          } catch (error) {
            if (error instanceof MultiplayerAdmissionError) {
              closeSocket(socket, 1013, error.code);
              return;
            }
            closeSocket(socket, 1011, "connection admission failed");
            return;
          }

          const now = Date.now();
          const state: ConnectionState = {
            socket,
            peer,
            createdAt: now,
            isAlive: true,
            pongDeadlineAt: null,
            nextPingAt: now + options.heartbeatIntervalSeconds * 1000
          };
          connections.set(socket, state);
          socket.on("pong", () => {
            state.isAlive = true;
            state.pongDeadlineAt = null;
          });
          socket.on("message", (payload) => {
            if (rawDataByteLength(payload) > options.limits.maxMessageBytes) {
              closeSocket(socket, 1009, "message too large");
              return;
            }
            options.hub.receive(peer, rawDataText(payload));
          });
          const cleanup = () => {
            connections.delete(socket);
            options.hub.disconnect(peer);
          };
          socket.on("close", cleanup);
          socket.on("error", cleanup);
        }
      });
    });
  });
}

function tokenFromRequest(request: FastifyRequest<{ Querystring: MultiplayerQuery }>): string {
  const authorization = request.headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  const explicit = request.headers["x-prg32-token"];
  if (typeof explicit === "string") return explicit.trim();
  return request.query.token?.trim() ?? "";
}

function sendBoundedJson(socket: WebSocket, message: Record<string, unknown>, limits: MultiplayerLimits): void {
  if (socket.readyState !== socket.OPEN) throw new Error("socket is not open");
  const payload = JSON.stringify(message);
  if (Buffer.byteLength(payload, "utf8") > limits.maxMessageBytes) {
    closeSocket(socket, 1009, "outbound message too large");
    throw new Error("outbound message too large");
  }
  if (socket.bufferedAmount > limits.maxBufferedBytes) {
    closeSocket(socket, 1013, "slow consumer");
    throw new Error("slow consumer");
  }
  socket.send(payload);
  if (socket.bufferedAmount > limits.maxBufferedBytes) {
    closeSocket(socket, 1013, "slow consumer");
    throw new Error("slow consumer");
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason.slice(0, 123));
}

function rawDataByteLength(payload: RawData): number {
  if (typeof payload === "string") return Buffer.byteLength(payload, "utf8");
  if (Array.isArray(payload)) return payload.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  return payload.byteLength;
}

function rawDataText(payload: RawData): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return Buffer.concat(payload).toString("utf8");
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString("utf8");
  return payload.toString("utf8");
}
