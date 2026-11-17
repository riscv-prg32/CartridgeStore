import { positiveInteger } from "./env-values.js";

/** Resolved multiplayer relay limits and timing settings. */
export interface MultiplayerEnvironmentConfig {
  readonly multiplayerMaxPeers: number;
  readonly multiplayerMaxConnections: number;
  readonly multiplayerMaxConnectionsPerSource: number;
  readonly multiplayerMaxConnectionsPerIdentity: number;
  readonly multiplayerMaxUnjoinedConnections: number;
  readonly multiplayerMessageRatePerSecond: number;
  readonly multiplayerMessageBurst: number;
  readonly multiplayerStateRatePerSecond: number;
  readonly multiplayerStateBurst: number;
  readonly multiplayerJoinRateMax: number;
  readonly multiplayerJoinRateWindowSeconds: number;
  readonly multiplayerSourceMessageRatePerSecond: number;
  readonly multiplayerSourceMessageBurst: number;
  readonly multiplayerIdentityMessageRatePerSecond: number;
  readonly multiplayerIdentityMessageBurst: number;
  readonly multiplayerHeartbeatIntervalSeconds: number;
  readonly multiplayerHeartbeatGraceSeconds: number;
  readonly multiplayerUnjoinedTimeoutSeconds: number;
  readonly multiplayerMaxBufferedBytes: number;
}

/** Parses multiplayer relay limits from the backend environment. */
export function resolveMultiplayerConfig(
  environment: NodeJS.ProcessEnv,
): MultiplayerEnvironmentConfig {
  return {
    multiplayerMaxPeers: positiveInteger(
      "PRG32_MP_MAX_PEERS",
      environment.PRG32_MP_MAX_PEERS,
      8,
    ),
    multiplayerMaxConnections: positiveInteger(
      "PRG32_BACKEND_MP_MAX_CONNECTIONS",
      environment.PRG32_BACKEND_MP_MAX_CONNECTIONS,
      256,
    ),
    multiplayerMaxConnectionsPerSource: positiveInteger(
      "PRG32_BACKEND_MP_MAX_CONNECTIONS_PER_SOURCE",
      environment.PRG32_BACKEND_MP_MAX_CONNECTIONS_PER_SOURCE,
      32,
    ),
    multiplayerMaxConnectionsPerIdentity: positiveInteger(
      "PRG32_BACKEND_MP_MAX_CONNECTIONS_PER_IDENTITY",
      environment.PRG32_BACKEND_MP_MAX_CONNECTIONS_PER_IDENTITY,
      4,
    ),
    multiplayerMaxUnjoinedConnections: positiveInteger(
      "PRG32_BACKEND_MP_MAX_UNJOINED_CONNECTIONS",
      environment.PRG32_BACKEND_MP_MAX_UNJOINED_CONNECTIONS,
      64,
    ),
    multiplayerMessageRatePerSecond: positiveInteger(
      "PRG32_BACKEND_MP_MESSAGE_RATE",
      environment.PRG32_BACKEND_MP_MESSAGE_RATE,
      60,
    ),
    multiplayerMessageBurst: positiveInteger(
      "PRG32_BACKEND_MP_MESSAGE_BURST",
      environment.PRG32_BACKEND_MP_MESSAGE_BURST,
      120,
    ),
    multiplayerStateRatePerSecond: positiveInteger(
      "PRG32_BACKEND_MP_STATE_RATE",
      environment.PRG32_BACKEND_MP_STATE_RATE,
      30,
    ),
    multiplayerStateBurst: positiveInteger(
      "PRG32_BACKEND_MP_STATE_BURST",
      environment.PRG32_BACKEND_MP_STATE_BURST,
      60,
    ),
    multiplayerJoinRateMax: positiveInteger(
      "PRG32_BACKEND_MP_JOIN_MAX",
      environment.PRG32_BACKEND_MP_JOIN_MAX,
      4,
    ),
    multiplayerJoinRateWindowSeconds: positiveInteger(
      "PRG32_BACKEND_MP_JOIN_WINDOW_SECONDS",
      environment.PRG32_BACKEND_MP_JOIN_WINDOW_SECONDS,
      10,
    ),
    multiplayerSourceMessageRatePerSecond: positiveInteger(
      "PRG32_BACKEND_MP_SOURCE_MESSAGE_RATE",
      environment.PRG32_BACKEND_MP_SOURCE_MESSAGE_RATE,
      300,
    ),
    multiplayerSourceMessageBurst: positiveInteger(
      "PRG32_BACKEND_MP_SOURCE_MESSAGE_BURST",
      environment.PRG32_BACKEND_MP_SOURCE_MESSAGE_BURST,
      600,
    ),
    multiplayerIdentityMessageRatePerSecond: positiveInteger(
      "PRG32_BACKEND_MP_IDENTITY_MESSAGE_RATE",
      environment.PRG32_BACKEND_MP_IDENTITY_MESSAGE_RATE,
      120,
    ),
    multiplayerIdentityMessageBurst: positiveInteger(
      "PRG32_BACKEND_MP_IDENTITY_MESSAGE_BURST",
      environment.PRG32_BACKEND_MP_IDENTITY_MESSAGE_BURST,
      240,
    ),
    multiplayerHeartbeatIntervalSeconds: positiveInteger(
      "PRG32_BACKEND_MP_HEARTBEAT_INTERVAL_SECONDS",
      environment.PRG32_BACKEND_MP_HEARTBEAT_INTERVAL_SECONDS,
      30,
    ),
    multiplayerHeartbeatGraceSeconds: positiveInteger(
      "PRG32_BACKEND_MP_HEARTBEAT_GRACE_SECONDS",
      environment.PRG32_BACKEND_MP_HEARTBEAT_GRACE_SECONDS,
      10,
    ),
    multiplayerUnjoinedTimeoutSeconds: positiveInteger(
      "PRG32_BACKEND_MP_UNJOINED_TIMEOUT_SECONDS",
      environment.PRG32_BACKEND_MP_UNJOINED_TIMEOUT_SECONDS,
      30,
    ),
    multiplayerMaxBufferedBytes: positiveInteger(
      "PRG32_BACKEND_MP_MAX_BUFFERED_BYTES",
      environment.PRG32_BACKEND_MP_MAX_BUFFERED_BYTES,
      256 * 1024,
    ),
  };
}
