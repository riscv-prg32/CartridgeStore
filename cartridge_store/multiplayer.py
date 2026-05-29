"""WebSocket multiplayer relay compatible with PRG32 MultiplayerServer."""

from __future__ import annotations

import json
import math
import re
from threading import Lock
from typing import Any, Callable

from flask import Flask, jsonify, request
from flask_sock import Sock


SIGNATURE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,47}$")


class MultiplayerPeer:
    def __init__(self, send_json: Callable[[dict[str, Any]], None]) -> None:
        self.send_json = send_json
        self.signature = ""
        self.flags = 0
        self.player_id = 0
        self.state: dict[str, Any] | None = None

    def send(self, message: dict[str, Any]) -> None:
        self.send_json(message)


class MultiplayerHub:
    def __init__(self, max_peers: int = 8) -> None:
        self.max_peers = max(1, max_peers)
        self.groups: dict[str, set[MultiplayerPeer]] = {}
        self.next_player_id = 1
        self.lock = Lock()

    def connect(self, send_json: Callable[[dict[str, Any]], None]) -> MultiplayerPeer:
        return MultiplayerPeer(send_json)

    def receive(self, peer: MultiplayerPeer, raw: str | bytes | dict[str, Any]) -> None:
        if isinstance(raw, dict):
            message = raw
        else:
            try:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                message = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                peer.send({"type": "error", "error": "invalid json"})
                return
            if not isinstance(message, dict):
                peer.send({"type": "error", "error": "invalid json"})
                return

        message_type = message.get("type")
        if message_type == "join":
            self.join(peer, message)
        elif message_type == "state":
            self.update_state(peer, message)
        elif message_type == "leave":
            self.leave(peer)
        else:
            peer.send({"type": "error", "error": "unknown message type"})

    def join(self, peer: MultiplayerPeer, message: dict[str, Any]) -> None:
        signature = str(message.get("signature", "")).strip()
        if not SIGNATURE_RE.fullmatch(signature):
            peer.send({"type": "error", "error": "invalid signature"})
            return

        with self.lock:
            self._leave_locked(peer)
            group = self.groups.setdefault(signature, set())
            if len(group) >= self.max_peers:
                peer.send({"type": "error", "error": "game room is full"})
                return

            player_id = self._choose_player_id(group, message.get("player_id"))
            peer.signature = signature
            peer.flags = _uint32(message.get("flags"))
            peer.player_id = player_id
            peer.state = None
            group.add(peer)

            peer.send({"type": "welcome", "player_id": player_id})
            for other in group:
                if other is not peer and other.state is not None:
                    peer.send(_peer_message(other.player_id, other.state))

    def update_state(self, peer: MultiplayerPeer, message: dict[str, Any]) -> None:
        with self.lock:
            if not peer.signature:
                peer.send({"type": "error", "error": "join first"})
                return
            state = {
                "x": message.get("x"),
                "y": message.get("y"),
                "sprite": message.get("sprite"),
                "flags": message.get("flags"),
                "input": message.get("input"),
                "frame": message.get("frame"),
            }
            peer.state = state
            self._broadcast_locked(
                peer.signature,
                _peer_message(peer.player_id, state),
                peer,
            )

    def leave(self, peer: MultiplayerPeer) -> None:
        with self.lock:
            self._leave_locked(peer)

    def status(self) -> dict[str, Any]:
        with self.lock:
            rooms = {
                signature: len(group)
                for signature, group in sorted(self.groups.items())
            }
            return {
                "rooms": rooms,
                "room_count": len(rooms),
                "max_peers": self.max_peers,
            }

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
        peer.signature = ""
        peer.flags = 0
        peer.player_id = 0
        peer.state = None
        self._broadcast_locked(
            signature,
            {"type": "leave", "player_id": player_id},
            peer,
        )

    def _broadcast_locked(
        self,
        signature: str,
        message: dict[str, Any],
        except_peer: MultiplayerPeer,
    ) -> None:
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
            peer.signature = ""
            peer.flags = 0
            peer.player_id = 0
            peer.state = None
        if not group:
            self.groups.pop(signature, None)

    def _choose_player_id(self, group: set[MultiplayerPeer], requested: Any) -> int:
        used = {peer.player_id for peer in group if peer.player_id}
        try:
            requested_id = int(requested)
        except (TypeError, ValueError):
            requested_id = 0
        if requested_id > 0 and requested_id not in used:
            return requested_id
        while self.next_player_id in used or self.next_player_id == 0:
            self.next_player_id = (self.next_player_id + 1) & 0xffffffff
        player_id = self.next_player_id
        self.next_player_id = (self.next_player_id + 1) & 0xffffffff
        return player_id


def _number(value: Any) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(number):
        return 0
    return int(number)


def _clamp(value: Any, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, _number(value)))


def _uint32(value: Any) -> int:
    return _number(value) & 0xffffffff


def _peer_message(player_id: int, state: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "peer",
        "player_id": player_id,
        "x": _clamp(state.get("x"), -32768, 32767),
        "y": _clamp(state.get("y"), -32768, 32767),
        "sprite": _clamp(state.get("sprite"), 0, 65535),
        "flags": _clamp(state.get("flags"), 0, 65535),
        "input": _clamp(state.get("input"), 0, 0xffffffff),
        "frame": _clamp(state.get("frame"), 0, 0xffffffff),
    }


def register_multiplayer_routes(app: Flask) -> None:
    hub = MultiplayerHub(max_peers=int(app.config["MULTIPLAYER_MAX_PEERS"]))
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
                "websocket": f"{scheme}://{request.host}/api/multiplayer",
                "protocol": {
                    "join": {"type": "join", "signature": "game-v1", "player_id": 1},
                    "state": {"type": "state", "x": 0, "y": 0, "frame": 0},
                    "leave": {"type": "leave"},
                },
            }
        )

    @sock.route("/api/multiplayer")
    def multiplayer_websocket(ws):
        peer = hub.connect(lambda message: ws.send(json.dumps(message)))
        try:
            while True:
                hub.receive(peer, ws.receive())
        finally:
            hub.leave(peer)
