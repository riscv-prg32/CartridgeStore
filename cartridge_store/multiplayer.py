"""WebSocket multiplayer relay speaking ``prg32-multiplayer-1.0``.

The wire protocol is the one specified by PRG32-Multiplayer-Server
(``docs/protocol.md`` in that repository).  This relay implements the same
contract so a console can use either server:

* clients ``join`` a room named by a cartridge ``signature`` and receive a
  ``welcome`` with the authoritative ``player_id``, a per-connection
  ``connection_id`` and a pseudonymous ``device_id``;
* ``state`` snapshots are validated and relayed to the other room members as
  ``peer`` messages; the server never echoes them and never stores them;
* ``leave``, ``ping``/``pong`` and coded ``error`` messages follow the spec.

The Cartridge Store adds one optional extension: when ``PRG32_USERS`` tokens
are configured, joining requires a token with at least the ``player`` role.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
from threading import Lock
import time
import uuid
from typing import Any, Callable

from flask import Flask, jsonify, request
from flask_sock import Sock

from .auth import (
    ANONYMOUS,
    Principal,
    authenticate_token,
    extract_token_from_headers,
    parse_user_config,
    role_at_least,
)


PROTOCOL = "prg32-multiplayer-1.0"
SIGNATURE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,47}$")
PLATFORMS = frozenset({"esp32c6", "qemu", "prg32-qt", "prg-ios"})
UINT32_MAX = 0xFFFFFFFF
DEFAULT_MAX_MESSAGE_BYTES = 1024
DEFAULT_MAX_MESSAGES_PER_SECOND = 40
DEFAULT_IDLE_TIMEOUT_SECONDS = 15.0

# (field, minimum, maximum) for every required ``state`` member.
STATE_FIELDS = (
    ("x", -32768, 32767),
    ("y", -32768, 32767),
    ("sprite", 0, 65535),
    ("flags", 0, 65535),
    ("input", 0, 0x7F),
    ("frame", 0, UINT32_MAX),
)

ERROR_TEXT = {
    "invalid_json": "invalid json",
    "invalid_message": "message must be a JSON object",
    "unknown_type": "unknown message type",
    "message_too_large": "message is too large",
    "invalid_signature": "invalid signature",
    "invalid_player_id": "invalid player_id",
    "invalid_flags": "invalid flags",
    "invalid_device_id": "invalid device_id",
    "join_required": "join first",
    "room_full": "game room is full",
    "rate_limited": "too many messages",
    "binary_not_supported": "binary frames are not supported",
    "unauthorized": "player role required",
}
POLICY_CLOSE_CODE = 1008


class ProtocolError(ValueError):
    """A message failed validation; ``code`` is the wire error code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _integer(value: Any, minimum: int, maximum: int) -> bool:
    """True for an exact JSON integer in range (``3`` or ``3.0``, never ``"3"``)."""
    if isinstance(value, bool):
        return False
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            return False
        value = int(value)
    return isinstance(value, int) and minimum <= value <= maximum


def parse_message(raw: str | bytes | dict[str, Any], max_bytes: int = DEFAULT_MAX_MESSAGE_BYTES) -> dict[str, Any]:
    """Decode and validate one client message, raising ``ProtocolError``."""
    if isinstance(raw, dict):
        message: Any = raw
    else:
        if isinstance(raw, bytes):
            raise ProtocolError("binary_not_supported")
        if len(raw.encode("utf-8")) > max_bytes:
            raise ProtocolError("message_too_large")
        try:
            message = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            raise ProtocolError("invalid_json") from None
    if not isinstance(message, dict):
        raise ProtocolError("invalid_message")

    kind = message.get("type")
    if kind == "join":
        if not isinstance(message.get("signature"), str) or not SIGNATURE_RE.fullmatch(message["signature"]):
            raise ProtocolError("invalid_signature")
        if "player_id" in message and not _integer(message["player_id"], 1, UINT32_MAX):
            raise ProtocolError("invalid_player_id")
        if "flags" in message and not _integer(message["flags"], 0, UINT32_MAX):
            raise ProtocolError("invalid_flags")
        device_id = message.get("device_id")
        if "device_id" in message and (not isinstance(device_id, str) or not 1 <= len(device_id) <= 128):
            raise ProtocolError("invalid_device_id")
        return message
    if kind == "state":
        for name, minimum, maximum in STATE_FIELDS:
            if not _integer(message.get(name), minimum, maximum):
                raise ProtocolError(f"invalid_{name}")
        return message
    if kind in ("leave", "ping"):
        return message
    raise ProtocolError("unknown_type")


def device_pseudonym(secret: bytes, platform: str, source: str) -> str:
    """``base64url(HMAC-SHA-256(secret, platform NUL source))[0:22]``."""
    digest = hmac.new(secret, f"{platform}\0{source}".encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:22]


class MultiplayerPeer:
    """One WebSocket connection; it is a room member only after ``welcome``."""

    def __init__(
        self,
        send_json: Callable[[dict[str, Any]], None],
        *,
        connection_token: str = "",
        principal: Principal = ANONYMOUS,
    ) -> None:
        self.send_json = send_json
        self.connection_token = connection_token
        self.principal = principal
        self.signature = ""
        self.flags = 0
        self.player_id = 0
        self.connection_id = ""
        self.device_id = ""
        self.platform = "unknown"
        self.persistent_device_id = False
        self.close_code: int | None = None
        self.rate_window = time.monotonic()
        self.rate_count = 0

    def send(self, message: dict[str, Any]) -> None:
        self.send_json(message)


class MultiplayerHub:
    def __init__(
        self,
        max_peers: int = 8,
        users: list[Principal] | None = None,
        *,
        device_id_secret: bytes | str | None = None,
        max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES,
        max_messages_per_second: int = DEFAULT_MAX_MESSAGES_PER_SECOND,
        idle_timeout: float = DEFAULT_IDLE_TIMEOUT_SECONDS,
    ) -> None:
        self.max_peers = max(1, max_peers)
        self.users = users or []
        if isinstance(device_id_secret, str):
            device_id_secret = device_id_secret.encode("utf-8")
        # Without a configured secret, pseudonyms are stable only for this process.
        self.device_id_secret = device_id_secret or secrets.token_bytes(32)
        self.max_message_bytes = max(128, max_message_bytes)
        self.max_messages_per_second = max(1, max_messages_per_second)
        self.idle_timeout = max(1.0, idle_timeout)
        self.groups: dict[str, set[MultiplayerPeer]] = {}
        self.connections = 0
        self.lock = Lock()

    def connect(
        self,
        send_json: Callable[[dict[str, Any]], None],
        *,
        connection_token: str = "",
    ) -> MultiplayerPeer:
        principal = authenticate_token(connection_token, self.users) if self.users else ANONYMOUS
        with self.lock:
            self.connections += 1
        return MultiplayerPeer(send_json, connection_token=connection_token, principal=principal)

    def disconnect(self, peer: MultiplayerPeer) -> None:
        self.leave(peer)
        with self.lock:
            self.connections = max(0, self.connections - 1)

    def receive(self, peer: MultiplayerPeer, raw: str | bytes | dict[str, Any] | None) -> bool:
        """Handle one incoming frame; return False when the socket must close."""
        if raw is None:
            return False
        if not self._within_rate(peer):
            self._fail(peer, "rate_limited")
            peer.close_code = POLICY_CLOSE_CODE
            return False
        try:
            message = parse_message(raw, self.max_message_bytes)
        except ProtocolError as exc:
            self._fail(peer, exc.code)
            return True

        kind = message["type"]
        if kind == "join":
            self.join(peer, message)
        elif kind == "state":
            self.update_state(peer, message)
        elif kind == "leave":
            self.leave(peer)
        else:
            peer.send({"type": "pong", "time": int(time.time() * 1000)})
        return True

    def join(self, peer: MultiplayerPeer, message: dict[str, Any]) -> None:
        principal = self._authorize(peer, message)
        if principal is None:
            peer.send(
                {
                    "type": "error",
                    "code": "unauthorized",
                    "error": ERROR_TEXT["unauthorized"],
                    "user": peer.principal.as_dict(),
                }
            )
            return

        signature = message["signature"]
        platform = message.get("platform") if message.get("platform") in PLATFORMS else "unknown"
        claimed = message.get("device_id") if isinstance(message.get("device_id"), str) else ""
        # Legacy clients send no identity: give them a connection-only pseudonym.
        source = claimed or f"legacy:{message.get('player_id', '')}:{uuid.uuid4()}"

        with self.lock:
            self._leave_locked(peer)
            group = self.groups.setdefault(signature, set())
            if len(group) >= self.max_peers:
                if not group:
                    self.groups.pop(signature, None)
                self._fail(peer, "room_full")
                return
            peer.principal = principal
            peer.signature = signature
            peer.flags = int(message.get("flags", 0))
            peer.player_id = self._choose_player_id(group, message.get("player_id"))
            peer.connection_id = str(uuid.uuid4())
            peer.platform = platform
            peer.device_id = device_pseudonym(self.device_id_secret, platform, source)
            peer.persistent_device_id = bool(claimed)
            group.add(peer)
            peer.send(
                {
                    "type": "welcome",
                    "protocol": PROTOCOL,
                    "player_id": peer.player_id,
                    "connection_id": peer.connection_id,
                    "device_id": peer.device_id,
                    "platform": peer.platform,
                    "persistent_device_id": peer.persistent_device_id,
                }
            )

    def update_state(self, peer: MultiplayerPeer, message: dict[str, Any]) -> None:
        with self.lock:
            if not peer.signature:
                self._fail(peer, "join_required")
                return
            # The sender is the connection: a claimed player_id is ignored.
            relay = {
                "type": "peer",
                "player_id": peer.player_id,
                "device_id": peer.device_id,
                "platform": peer.platform,
            }
            for name, _, _ in STATE_FIELDS:
                relay[name] = int(message[name])
            self._broadcast_locked(peer.signature, relay, peer)

    def leave(self, peer: MultiplayerPeer) -> None:
        with self.lock:
            self._leave_locked(peer)

    def status(self) -> dict[str, Any]:
        with self.lock:
            rooms = {signature: len(group) for signature, group in sorted(self.groups.items())}
            return {
                "protocol": PROTOCOL,
                "rooms": rooms,
                "room_count": len(rooms),
                "players": sum(rooms.values()),
                "connections": self.connections,
                "max_peers": self.max_peers,
                "max_message_bytes": self.max_message_bytes,
                "max_messages_per_second": self.max_messages_per_second,
                "idle_timeout_ms": int(self.idle_timeout * 1000),
                "auth_enabled": bool(self.users),
            }

    def _authorize(self, peer: MultiplayerPeer, message: dict[str, Any]) -> Principal | None:
        if not self.users:
            return ANONYMOUS
        token = str(message.get("token") or message.get("auth_token") or peer.connection_token or "").strip()
        principal = authenticate_token(token, self.users)
        peer.principal = principal
        if principal.authenticated and role_at_least(principal.role, "player"):
            return principal
        return None

    def _within_rate(self, peer: MultiplayerPeer) -> bool:
        now = time.monotonic()
        if now - peer.rate_window >= 1.0:
            peer.rate_window = now
            peer.rate_count = 0
        peer.rate_count += 1
        return peer.rate_count <= self.max_messages_per_second

    def _fail(self, peer: MultiplayerPeer, code: str) -> None:
        # ``code`` is the protocol field; ``error`` keeps older store clients working.
        try:
            peer.send({"type": "error", "code": code, "error": ERROR_TEXT.get(code, code)})
        except Exception:
            pass

    def _reset(self, peer: MultiplayerPeer) -> None:
        peer.signature = ""
        peer.flags = 0
        peer.player_id = 0
        peer.connection_id = ""

    def _leave_locked(self, peer: MultiplayerPeer) -> None:
        if not peer.signature:
            return
        signature = peer.signature
        player_id = peer.player_id
        group = self.groups.get(signature)
        if group is not None:
            group.discard(peer)
            if not group:
                self.groups.pop(signature, None)
        self._reset(peer)
        self._broadcast_locked(signature, {"type": "leave", "player_id": player_id}, peer)

    def _broadcast_locked(self, signature: str, message: dict[str, Any], except_peer: MultiplayerPeer) -> None:
        group = self.groups.get(signature)
        if not group:
            return
        stale: list[MultiplayerPeer] = []
        for peer in list(group):
            if peer is not except_peer:
                try:
                    peer.send(message)
                except Exception:
                    stale.append(peer)
        for peer in stale:
            group.discard(peer)
            self._reset(peer)
        if not group:
            self.groups.pop(signature, None)

    def _choose_player_id(self, group: set[MultiplayerPeer], requested: Any) -> int:
        used = {peer.player_id for peer in group if peer.player_id}
        if _integer(requested, 1, UINT32_MAX) and int(requested) not in used:
            return int(requested)
        while True:
            candidate = secrets.randbelow(UINT32_MAX) + 1
            if candidate not in used:
                return candidate


def _configured_users(app: Flask) -> list[Principal]:
    raw = app.config.get("USERS")
    if raw is None:
        raw = os.environ.get("PRG32_USERS", "")
    return parse_user_config(raw)


def _device_id_secret(app: Flask) -> bytes:
    configured = app.config.get("MULTIPLAYER_DEVICE_ID_SECRET") or os.environ.get("PRG32_MP_DEVICE_ID_SECRET", "")
    if configured:
        return str(configured).encode("utf-8")
    # Derived from SECRET_KEY so pseudonyms survive restarts without a new setting.
    return hmac.new(
        str(app.config["SECRET_KEY"]).encode("utf-8"),
        b"prg32-multiplayer-device-id",
        hashlib.sha256,
    ).digest()


def register_multiplayer_routes(app: Flask) -> None:
    hub = MultiplayerHub(
        max_peers=int(app.config["MULTIPLAYER_MAX_PEERS"]),
        users=_configured_users(app),
        device_id_secret=_device_id_secret(app),
        max_message_bytes=int(os.environ.get("PRG32_MP_MAX_MESSAGE_BYTES", DEFAULT_MAX_MESSAGE_BYTES)),
        max_messages_per_second=int(os.environ.get("PRG32_MP_MAX_RATE", DEFAULT_MAX_MESSAGES_PER_SECOND)),
        idle_timeout=float(os.environ.get("PRG32_MP_IDLE_TIMEOUT", DEFAULT_IDLE_TIMEOUT_SECONDS)),
    )
    app.extensions["prg32_multiplayer_hub"] = hub
    sock = Sock(app)

    @app.get("/api/multiplayer/status")
    def multiplayer_status():
        return jsonify({"ok": True, "multiplayer": hub.status()})

    @app.get("/api/multiplayer")
    def multiplayer_info():
        scheme = "wss" if request.scheme == "https" else "ws"
        return jsonify(
            {
                "ok": True,
                "service": "PRG32 multiplayer relay",
                "protocol_id": PROTOCOL,
                "websocket": f"{scheme}://{request.host}/api/multiplayer",
                "auth_enabled": bool(hub.users),
                "limits": {
                    "max_peers": hub.max_peers,
                    "max_message_bytes": hub.max_message_bytes,
                    "max_messages_per_second": hub.max_messages_per_second,
                    "idle_timeout_ms": int(hub.idle_timeout * 1000),
                },
                "platforms": sorted(PLATFORMS),
                "protocol": {
                    "join": {
                        "type": "join",
                        "signature": "game-v1",
                        "player_id": 1,
                        "protocol": PROTOCOL,
                        "platform": "qemu",
                        "device_id": "installation-uuid",
                    },
                    "state": {"type": "state", "x": 0, "y": 0, "sprite": 0, "flags": 0, "input": 0, "frame": 0},
                    "leave": {"type": "leave"},
                    "ping": {"type": "ping"},
                },
            }
        )

    @sock.route("/api/multiplayer")
    def multiplayer_websocket(ws):
        token = extract_token_from_headers(request.headers, request.args.get("token", ""))
        peer = hub.connect(lambda message: ws.send(json.dumps(message)), connection_token=token)
        try:
            while True:
                # ``receive`` returns None after the idle timeout: close the socket.
                if not hub.receive(peer, ws.receive(timeout=hub.idle_timeout)):
                    break
        finally:
            hub.disconnect(peer)
            try:
                ws.close(reason=peer.close_code or 1001, message="policy" if peer.close_code else "idle_timeout")
            except Exception:
                pass
