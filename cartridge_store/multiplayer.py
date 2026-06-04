"""WebSocket relay integrated from the PRG32 MultiplayerServer."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .auth import (
    ANONYMOUS,
    Principal,
    authenticate_token,
    extract_token_from_headers,
    parse_user_config,
    role_at_least,
)

try:
    import websockets
except ImportError:  # pragma: no cover - exercised by runtime environment
    websockets = None


SIGNATURE_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,47}$")


class MultiplayerRelay:
    def __init__(self, *, max_peers: int = 8, users: list[Principal] | None = None) -> None:
        self.max_peers = max(1, max_peers)
        self.users = users or []
        self.groups: dict[str, set[Any]] = {}
        self.clients: dict[Any, dict[str, Any]] = {}
        self.next_player_id = 1

    def group_for(self, signature: str) -> set[Any]:
        group = self.groups.get(signature)
        if group is None:
            group = set()
            self.groups[signature] = group
        return group

    async def send(self, websocket: Any, message: dict[str, Any]) -> None:
        try:
            await websocket.send(json.dumps(message, separators=(",", ":")))
        except Exception:
            pass

    async def broadcast(self, signature: str, message: dict[str, Any], except_ws: Any) -> None:
        group = self.groups.get(signature)
        if not group:
            return
        for websocket in list(group):
            if websocket is not except_ws:
                await self.send(websocket, message)

    async def leave(self, websocket: Any) -> None:
        client = self.clients.get(websocket)
        if not client or not client.get("signature"):
            return
        signature = str(client["signature"])
        player_id = int(client.get("player_id") or 0)
        group = self.groups.get(signature)
        if group:
            group.discard(websocket)
            if not group:
                self.groups.pop(signature, None)
        client["signature"] = ""
        await self.broadcast(signature, {"type": "leave", "player_id": player_id}, websocket)

    def active_player_ids(self, group: set[Any]) -> set[int]:
        ids: set[int] = set()
        for websocket in group:
            client = self.clients.get(websocket)
            if client and client.get("player_id"):
                ids.add(int(client["player_id"]))
        return ids

    def choose_player_id(self, group: set[Any], requested: Any) -> int:
        used = self.active_player_ids(group)
        try:
            requested_id = int(requested)
        except (TypeError, ValueError):
            requested_id = 0
        if requested_id > 0 and requested_id not in used:
            return requested_id

        while self.next_player_id in used or self.next_player_id == 0:
            self.next_player_id = (self.next_player_id + 1) & 0xFFFFFFFF
        player_id = self.next_player_id
        self.next_player_id = (self.next_player_id + 1) & 0xFFFFFFFF
        return player_id

    def authorize(self, message: dict[str, Any], connection_token: str) -> tuple[bool, Principal]:
        if not self.users:
            return True, ANONYMOUS
        token = str(message.get("token") or message.get("auth_token") or connection_token or "").strip()
        principal = authenticate_token(token, self.users)
        return principal.authenticated and role_at_least(principal.role, "player"), principal

    @staticmethod
    def clamp_number(value: Any, lower: int, upper: int) -> int:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return 0
        if not math.isfinite(number):
            return 0
        return max(lower, min(upper, int(number)))

    def peer_message(self, player_id: int, state: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "peer",
            "player_id": player_id,
            "x": self.clamp_number(state.get("x"), -32768, 32767),
            "y": self.clamp_number(state.get("y"), -32768, 32767),
            "sprite": self.clamp_number(state.get("sprite"), 0, 65535),
            "flags": self.clamp_number(state.get("flags"), 0, 65535),
            "input": self.clamp_number(state.get("input"), 0, 0xFFFFFFFF),
            "frame": self.clamp_number(state.get("frame"), 0, 0xFFFFFFFF),
        }

    async def join(self, websocket: Any, message: dict[str, Any], connection_token: str) -> None:
        authorized, principal = self.authorize(message, connection_token)
        if not authorized:
            await self.send(
                websocket,
                {
                    "type": "error",
                    "error": "player role required",
                    "user": principal.as_dict(),
                },
            )
            return

        signature = message.get("signature") if isinstance(message.get("signature"), str) else ""
        signature = signature.strip()
        if not SIGNATURE_PATTERN.fullmatch(signature):
            await self.send(websocket, {"type": "error", "error": "invalid signature"})
            return

        await self.leave(websocket)

        group = self.group_for(signature)
        if len(group) >= self.max_peers:
            await self.send(websocket, {"type": "error", "error": "game room is full"})
            return

        player_id = self.choose_player_id(group, message.get("player_id"))
        self.clients[websocket] = {
            "signature": signature,
            "flags": self.clamp_number(message.get("flags"), 0, 0xFFFFFFFF),
            "player_id": player_id,
            "state": None,
            "user": principal.name,
        }
        group.add(websocket)

        await self.send(websocket, {"type": "welcome", "player_id": player_id})
        for peer in list(group):
            client = self.clients.get(peer)
            if peer is not websocket and client and client.get("state"):
                await self.send(websocket, self.peer_message(int(client["player_id"]), client["state"]))

    async def update_state(self, websocket: Any, message: dict[str, Any]) -> None:
        client = self.clients.get(websocket)
        if not client or not client.get("signature"):
            await self.send(websocket, {"type": "error", "error": "join first"})
            return

        state = {
            "x": message.get("x"),
            "y": message.get("y"),
            "sprite": message.get("sprite"),
            "flags": message.get("flags"),
            "input": message.get("input"),
            "frame": message.get("frame"),
        }
        client["state"] = state
        await self.broadcast(
            str(client["signature"]),
            self.peer_message(int(client["player_id"]), state),
            websocket,
        )

    @staticmethod
    def request_path(websocket: Any, path: str | None) -> str:
        if path:
            return path
        request_obj = getattr(websocket, "request", None)
        return str(getattr(request_obj, "path", "") or "")

    @staticmethod
    def request_headers(websocket: Any) -> Any:
        request_obj = getattr(websocket, "request", None)
        headers = getattr(request_obj, "headers", None)
        return headers if headers is not None else getattr(websocket, "request_headers", {})

    async def handle(self, websocket: Any, path: str | None = None) -> None:
        request_path = self.request_path(websocket, path)
        query_token = parse_qs(urlsplit(request_path).query).get("token", [""])[0]
        header_token = extract_token_from_headers(self.request_headers(websocket), "")
        connection_token = header_token or query_token
        self.clients[websocket] = {
            "signature": "",
            "flags": 0,
            "player_id": 0,
            "state": None,
            "user": "",
        }

        try:
            async for raw in websocket:
                try:
                    text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
                    message = json.loads(text)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    await self.send(websocket, {"type": "error", "error": "invalid json"})
                    continue
                if not isinstance(message, dict):
                    await self.send(websocket, {"type": "error", "error": "invalid json"})
                    continue

                message_type = message.get("type")
                if message_type == "join":
                    await self.join(websocket, message, connection_token)
                elif message_type == "state":
                    await self.update_state(websocket, message)
                elif message_type == "leave":
                    await self.leave(websocket)
                else:
                    await self.send(websocket, {"type": "error", "error": "unknown message type"})
        finally:
            await self.leave(websocket)
            self.clients.pop(websocket, None)

    async def serve(self, host: str, port: int) -> None:
        if websockets is None:
            raise RuntimeError("install the websockets package to run the multiplayer relay")
        async with websockets.serve(self.handle, host, port):
            print(f"PRG32 multiplayer relay listening on ws://{host}:{port}", flush=True)
            await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the PRG32 multiplayer WebSocket relay.")
    parser.add_argument("--host", default=os.environ.get("PRG32_MP_HOST", "0.0.0.0"))
    parser.add_argument("--port", default=int(os.environ.get("PRG32_MP_PORT", "8081")), type=int)
    parser.add_argument(
        "--max-peers",
        default=int(os.environ.get("PRG32_MP_MAX_PEERS", "8")),
        type=int,
    )
    parser.add_argument(
        "--users",
        default=os.environ.get("PRG32_USERS", ""),
        help="optional JSON or name:role:token user configuration",
    )
    args = parser.parse_args()

    relay = MultiplayerRelay(
        max_peers=args.max_peers,
        users=parse_user_config(args.users),
    )
    asyncio.run(relay.serve(args.host, args.port))


if __name__ == "__main__":
    main()
