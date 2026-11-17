import { ANONYMOUS, principalToJson, roleAtLeast, type Principal } from "../auth/principal.js";

export const MULTIPLAYER_SIGNATURE_RE = /^[A-Za-z0-9_.:-]{1,47}$/;
const MAX_JSON_DEPTH = 16;

export interface MultiplayerLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerSource: number;
  readonly maxConnectionsPerIdentity: number;
  readonly maxUnjoinedConnections: number;
  readonly messageRatePerSecond: number;
  readonly messageBurst: number;
  readonly stateRatePerSecond: number;
  readonly stateBurst: number;
  readonly joinRateMax: number;
  readonly joinRateWindowSeconds: number;
  readonly sourceMessageRatePerSecond: number;
  readonly sourceMessageBurst: number;
  readonly identityMessageRatePerSecond: number;
  readonly identityMessageBurst: number;
  readonly maxMessageBytes: number;
  readonly maxBufferedBytes: number;
}

export type MultiplayerAdmissionCode = "global_connection_limit" | "source_connection_limit" | "unjoined_connection_limit" | "identity_connection_limit";

export class MultiplayerAdmissionError extends Error {
  constructor(readonly code: MultiplayerAdmissionCode) {
    super("multiplayer connection limit reached");
    this.name = "MultiplayerAdmissionError";
  }
}

class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(private readonly ratePerSecond: number, private readonly burst: number, now = Date.now()) {
    this.tokens = burst;
    this.lastRefillAt = now;
  }

  consume(now = Date.now()): boolean {
    const elapsedSeconds = Math.max(0, now - this.lastRefillAt) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefillAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface JoinWindow { count: number; startedAt: number }

export interface MultiplayerPeer {
  readonly sendJson: (message: Record<string, unknown>) => void;
  readonly closeConnection: (code: number, reason: string) => void;
  readonly connectionToken: string;
  readonly sourceKey: string;
  principal: Principal;
  signature: string;
  flags: number;
  playerId: number;
  state: Record<string, unknown> | null;
  joinedOnce: boolean;
  closed: boolean;
  identityKey: string | null;
  readonly messageBucket: TokenBucket;
  readonly stateBucket: TokenBucket;
  joinWindow: JoinWindow;
}

export interface MultiplayerHubOptions {
  readonly maxPeers: number;
  readonly authenticationEnabled: boolean;
  readonly authenticate: (token: string) => Principal;
  readonly limits: MultiplayerLimits;
}

export class MultiplayerHub {
  readonly maxPeers: number;
  readonly authenticationEnabled: boolean;
  private readonly authenticateToken: (token: string) => Principal;
  private readonly limits: MultiplayerLimits;
  private readonly groups = new Map<string, Set<MultiplayerPeer>>();
  private readonly peers = new Set<MultiplayerPeer>();
  private readonly sourceCounts = new Map<string, number>();
  private readonly identityCounts = new Map<string, number>();
  private readonly sourceBuckets = new Map<string, TokenBucket>();
  private readonly identityBuckets = new Map<string, TokenBucket>();
  private unjoinedCount = 0;
  private nextPlayerId = 1;

  constructor(options: MultiplayerHubOptions) {
    this.maxPeers = Math.max(1, options.maxPeers);
    this.authenticationEnabled = options.authenticationEnabled;
    this.authenticateToken = options.authenticate;
    this.limits = options.limits;
  }

  connect(sendJson: (message: Record<string, unknown>) => void, connectionToken = "", sourceKey = "unknown", closeConnection: (code: number, reason: string) => void = () => undefined): MultiplayerPeer {
    if (this.peers.size >= this.limits.maxConnections) throw new MultiplayerAdmissionError("global_connection_limit");
    if ((this.sourceCounts.get(sourceKey) ?? 0) >= this.limits.maxConnectionsPerSource) throw new MultiplayerAdmissionError("source_connection_limit");
    if (this.unjoinedCount >= this.limits.maxUnjoinedConnections) throw new MultiplayerAdmissionError("unjoined_connection_limit");
    this.increment(this.sourceCounts, sourceKey);
    this.unjoinedCount += 1;
    let principal: Principal;
    try {
      principal = this.authenticateToken(connectionToken);
    } catch (error) {
      this.decrement(this.sourceCounts, sourceKey);
      this.unjoinedCount -= 1;
      throw error;
    }
    const identityKey = identityKeyFor(principal);
    if (identityKey !== null && (this.identityCounts.get(identityKey) ?? 0) >= this.limits.maxConnectionsPerIdentity) {
      this.decrement(this.sourceCounts, sourceKey);
      this.unjoinedCount -= 1;
      throw new MultiplayerAdmissionError("identity_connection_limit");
    }
    if (identityKey !== null) this.increment(this.identityCounts, identityKey);
    const now = Date.now();
    const peer: MultiplayerPeer = {
      sendJson, closeConnection, connectionToken, sourceKey, principal,
      signature: "", flags: 0, playerId: 0, state: null, joinedOnce: false,
      closed: false, identityKey,
      messageBucket: new TokenBucket(this.limits.messageRatePerSecond, this.limits.messageBurst, now),
      stateBucket: new TokenBucket(this.limits.stateRatePerSecond, this.limits.stateBurst, now),
      joinWindow: { count: 0, startedAt: now }
    };
    this.peers.add(peer);
    if (this.sourceCounts.get(sourceKey) === 1) this.sourceBuckets.set(sourceKey, new TokenBucket(this.limits.sourceMessageRatePerSecond, this.limits.sourceMessageBurst, now));
    if (identityKey !== null && this.identityCounts.get(identityKey) === 1) this.identityBuckets.set(identityKey, new TokenBucket(this.limits.identityMessageRatePerSecond, this.limits.identityMessageBurst, now));
    return peer;
  }

  receive(peer: MultiplayerPeer, raw: string | Record<string, unknown>): void {
    if (peer.closed) return;
    if (!this.consumeMessage(peer)) {
      this.rejectAbusivePeer(peer, "message rate limited", "message_rate_limited");
      return;
    }
    let message: Record<string, unknown>;
    if (typeof raw === "string") {
      if (Buffer.byteLength(raw, "utf8") > this.limits.maxMessageBytes || exceedsJsonDepth(raw, MAX_JSON_DEPTH)) {
        this.rejectAbusivePeer(peer, "message too large", "message_too_large");
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) throw new Error("invalid json");
        message = parsed;
      } catch {
        peer.sendJson({ type: "error", error: "invalid json" });
        return;
      }
    } else message = raw;
    const validationError = validateMessage(message);
    if (validationError !== null) {
      peer.sendJson({ type: "error", error: validationError });
      return;
    }
    switch (message.type) {
      case "join":
        if (!this.consumeJoin(peer)) {
          this.rejectAbusivePeer(peer, "join rate limited", "join_rate_limited");
          return;
        }
        this.join(peer, message);
        break;
      case "state":
        if (!peer.stateBucket.consume()) {
          this.rejectAbusivePeer(peer, "state rate limited", "state_rate_limited");
          return;
        }
        this.updateState(peer, message);
        break;
      case "leave":
        this.leave(peer);
        break;
      default:
        peer.sendJson({ type: "error", error: "unknown message type" });
    }
  }

  join(peer: MultiplayerPeer, message: Record<string, unknown>): void {
    const principal = this.authorize(peer, message);
    if (principal === null) {
      peer.sendJson({ type: "error", error: "player role required", user: principalToJson(peer.principal) });
      return;
    }
    const signature = stringValue(message.signature).trim();
    if (!MULTIPLAYER_SIGNATURE_RE.test(signature)) {
      peer.sendJson({ type: "error", error: "invalid signature" });
      return;
    }
    this.leaveLocked(peer);
    const group = this.groups.get(signature) ?? new Set<MultiplayerPeer>();
    if (group.size >= this.maxPeers) {
      peer.sendJson({ type: "error", error: "game room is full" });
      return;
    }
    const identityKey = identityKeyFor(principal);
    if (identityKey !== peer.identityKey) {
      if (identityKey !== null && (this.identityCounts.get(identityKey) ?? 0) >= this.limits.maxConnectionsPerIdentity) {
        peer.sendJson({ type: "error", error: "identity connection limit reached", code: "identity_connection_limit" });
        return;
      }
      this.releaseIdentity(peer.identityKey);
      if (identityKey !== null) {
        this.increment(this.identityCounts, identityKey);
        this.identityBuckets.set(identityKey, this.identityBuckets.get(identityKey) ?? new TokenBucket(this.limits.identityMessageRatePerSecond, this.limits.identityMessageBurst));
      }
      peer.identityKey = identityKey;
    }
    const playerId = this.choosePlayerId(group, message.player_id);
    peer.principal = principal;
    peer.signature = signature;
    peer.flags = uint32(message.flags);
    peer.playerId = playerId;
    peer.state = null;
    if (!peer.joinedOnce) {
      peer.joinedOnce = true;
      this.unjoinedCount = Math.max(0, this.unjoinedCount - 1);
    }
    group.add(peer);
    this.groups.set(signature, group);
    peer.sendJson({ type: "welcome", player_id: playerId });
    for (const other of group) if (other !== peer && other.state !== null) peer.sendJson(peerMessage(other.playerId, other.state));
  }

  updateState(peer: MultiplayerPeer, message: Record<string, unknown>): void {
    if (!peer.signature) {
      peer.sendJson({ type: "error", error: "join first" });
      return;
    }
    const state: Record<string, unknown> = { x: message.x, y: message.y, sprite: message.sprite, flags: message.flags, input: message.input, frame: message.frame };
    peer.state = state;
    this.broadcast(peer.signature, peerMessage(peer.playerId, state), peer);
  }

  leave(peer: MultiplayerPeer): void { this.leaveLocked(peer); }

  status(): { readonly rooms: Record<string, number>; readonly room_count: number; readonly max_peers: number; readonly auth_enabled: boolean } {
    const rooms: Record<string, number> = {};
    for (const [signature, group] of [...this.groups.entries()].sort(([a], [b]) => a.localeCompare(b))) rooms[signature] = group.size;
    return { rooms, room_count: Object.keys(rooms).length, max_peers: this.maxPeers, auth_enabled: this.authenticationEnabled };
  }

  disconnect(peer: MultiplayerPeer): void {
    if (peer.closed) return;
    peer.closed = true;
    this.leaveLocked(peer);
    this.peers.delete(peer);
    this.releasePeerCounts(peer);
  }

  close(): void {
    for (const peer of [...this.peers]) {
      peer.closed = true;
      this.leaveLocked(peer);
      this.releasePeerCounts(peer);
    }
    this.peers.clear();
    this.groups.clear();
    this.sourceBuckets.clear();
    this.identityBuckets.clear();
    this.sourceCounts.clear();
    this.identityCounts.clear();
    this.unjoinedCount = 0;
  }

  private consumeMessage(peer: MultiplayerPeer): boolean {
    const now = Date.now();
    if (!peer.messageBucket.consume(now)) return false;
    if (!this.sourceBuckets.get(peer.sourceKey)?.consume(now)) return false;
    if (peer.identityKey !== null && !this.identityBuckets.get(peer.identityKey)?.consume(now)) return false;
    return true;
  }

  private consumeJoin(peer: MultiplayerPeer): boolean {
    const now = Date.now();
    if (now - peer.joinWindow.startedAt >= this.limits.joinRateWindowSeconds * 1000) peer.joinWindow = { count: 0, startedAt: now };
    peer.joinWindow.count += 1;
    return peer.joinWindow.count <= this.limits.joinRateMax;
  }

  private rejectAbusivePeer(peer: MultiplayerPeer, message: string, code: string): void {
    try { peer.sendJson({ type: "error", error: message, code }); } catch { /* close below is authoritative */ }
    this.disconnect(peer);
    peer.closeConnection(1008, message);
  }

  private authorize(peer: MultiplayerPeer, message: Record<string, unknown>): Principal | null {
    if (!this.authenticationEnabled) return ANONYMOUS;
    const token = stringValue(message.token || message.auth_token || peer.connectionToken).trim();
    const principal = this.authenticateToken(token);
    peer.principal = principal;
    return principal.authenticated && roleAtLeast(principal.role, "player") ? principal : null;
  }

  private leaveLocked(peer: MultiplayerPeer): void {
    if (!peer.signature) return;
    const signature = peer.signature;
    const playerId = peer.playerId;
    const group = this.groups.get(signature);
    group?.delete(peer);
    if (group?.size === 0) this.groups.delete(signature);
    peer.signature = "";
    peer.flags = 0;
    peer.playerId = 0;
    peer.state = null;
    this.broadcast(signature, { type: "leave", player_id: playerId }, peer);
  }

  private broadcast(signature: string, message: Record<string, unknown>, exceptPeer: MultiplayerPeer): void {
    const group = this.groups.get(signature);
    if (!group) return;
    const stale: MultiplayerPeer[] = [];
    for (const peer of group) {
      if (peer === exceptPeer || peer.closed) continue;
      try { peer.sendJson(message); } catch { stale.push(peer); }
    }
    for (const peer of stale) {
      peer.closed = true;
      group.delete(peer);
      peer.signature = "";
      peer.flags = 0;
      peer.playerId = 0;
      peer.state = null;
      this.releasePeerCounts(peer);
      this.peers.delete(peer);
    }
    if (group.size === 0) this.groups.delete(signature);
  }

  private choosePlayerId(group: Set<MultiplayerPeer>, requested: unknown): number {
    const used = new Set([...group].map((peer) => peer.playerId).filter(Boolean));
    const requestedId = integer(requested);
    if (requestedId > 0 && !used.has(requestedId)) return requestedId;
    while (used.has(this.nextPlayerId) || this.nextPlayerId === 0) this.nextPlayerId = (this.nextPlayerId + 1) >>> 0;
    const playerId = this.nextPlayerId;
    this.nextPlayerId = (this.nextPlayerId + 1) >>> 0;
    return playerId;
  }

  private releasePeerCounts(peer: MultiplayerPeer): void {
    this.decrement(this.sourceCounts, peer.sourceKey);
    if (this.sourceCounts.get(peer.sourceKey) === undefined) this.sourceBuckets.delete(peer.sourceKey);
    this.releaseIdentity(peer.identityKey);
    peer.identityKey = null;
    if (!peer.joinedOnce) this.unjoinedCount = Math.max(0, this.unjoinedCount - 1);
  }

  private releaseIdentity(identityKey: string | null): void {
    if (identityKey === null) return;
    this.decrement(this.identityCounts, identityKey);
    if (this.identityCounts.get(identityKey) === undefined) this.identityBuckets.delete(identityKey);
  }

  private increment(map: Map<string, number>, key: string): void { map.set(key, (map.get(key) ?? 0) + 1); }

  private decrement(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 0) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }
}

function identityKeyFor(principal: Principal): string | null {
  if (!principal.authenticated) return null;
  if (principal.id !== null) return `id:${principal.id}`;
  return `name:${principal.username || principal.name}`;
}

function validateMessage(message: Record<string, unknown>): string | null {
  if (Object.keys(message).length > 16) return "message has too many fields";
  if (typeof message.type !== "string") return "message type is required";
  for (const value of Object.values(message)) {
    if (value !== null && typeof value === "object") return "nested message fields are not allowed";
    if (typeof value === "string" && value.length > 512) return "message field is too long";
    if (typeof value === "number" && !Number.isFinite(value)) return "message number is invalid";
  }
  if (message.type === "join" && typeof message.signature !== "string") return "invalid signature";
  if (message.type === "state") {
    for (const field of ["x", "y", "sprite", "flags", "input", "frame", "player_id"]) {
      if (message[field] !== undefined && typeof message[field] !== "number") return "state field is invalid";
    }
  }
  return null;
}

function exceedsJsonDepth(value: string, maximum: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maximum) return true;
    } else if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function uint32(value: unknown): number { return integer(value) >>> 0; }

function clamp(value: unknown, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, integer(value)));
}

function peerMessage(playerId: number, state: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "peer", player_id: playerId,
    x: clamp(state.x, -32768, 32767), y: clamp(state.y, -32768, 32767),
    sprite: clamp(state.sprite, 0, 65535), flags: clamp(state.flags, 0, 65535),
    input: clamp(state.input, 0, 0xffffffff), frame: clamp(state.frame, 0, 0xffffffff)
  };
}
