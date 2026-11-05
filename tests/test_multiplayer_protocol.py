"""Conformance of the relay with prg32-multiplayer-1.0 (PRG32-Multiplayer-Server)."""

from __future__ import annotations

import json
import re

import pytest

from cartridge_store.multiplayer import PROTOCOL, MultiplayerHub, device_pseudonym, parse_message, ProtocolError


STATE = {"type": "state", "x": 148, "y": 91, "sprite": 3, "flags": 1, "input": 16, "frame": 9402}


def joined(hub: MultiplayerHub, signature: str = "poing-wall:v1", **fields):
    messages: list[dict] = []
    peer = hub.connect(messages.append)
    hub.receive(peer, json.dumps({"type": "join", "signature": signature, **fields}))
    return peer, messages


def test_welcome_carries_identity_fields() -> None:
    hub = MultiplayerHub(device_id_secret=b"secret")
    _, messages = joined(
        hub,
        player_id=2718281828,
        protocol=PROTOCOL,
        platform="qemu",
        device_id="d3b07384-d9a0-4c2c-8a58-57f7b70b77e6",
    )
    welcome = messages[0]
    assert welcome["type"] == "welcome"
    assert welcome["protocol"] == PROTOCOL
    assert welcome["player_id"] == 2718281828
    assert re.fullmatch(r"[0-9a-f-]{36}", welcome["connection_id"])
    assert re.fullmatch(r"[A-Za-z0-9_-]{22}", welcome["device_id"])
    assert welcome["platform"] == "qemu"
    assert welcome["persistent_device_id"] is True


def test_device_pseudonym_matches_reference_formula() -> None:
    # base64url(HMAC-SHA-256(secret, platform NUL source))[0:22], as in src/identity.js
    import base64
    import hashlib
    import hmac

    expected = base64.urlsafe_b64encode(
        hmac.new(b"s", b"qemu\0abc", hashlib.sha256).digest()
    ).decode().rstrip("=")[:22]
    assert device_pseudonym(b"s", "qemu", "abc") == expected


def test_same_installation_same_device_id_new_connection_id() -> None:
    hub = MultiplayerHub(device_id_secret=b"secret")
    _, first = joined(hub, platform="esp32c6", device_id="aabbccddeeff")
    _, second = joined(hub, platform="esp32c6", device_id="aabbccddeeff")
    assert first[0]["device_id"] == second[0]["device_id"]
    assert first[0]["connection_id"] != second[0]["connection_id"]
    _, other = joined(hub, platform="esp32c6", device_id="112233445566")
    assert other[0]["device_id"] != first[0]["device_id"]


def test_legacy_join_gets_connection_only_identity() -> None:
    hub = MultiplayerHub()
    _, messages = joined(hub, platform="amiga", player_id=7)
    assert messages[0]["platform"] == "unknown"
    assert messages[0]["persistent_device_id"] is False


def test_state_relays_peer_without_echo_and_ignores_claimed_player_id() -> None:
    hub = MultiplayerHub()
    sender, sender_messages = joined(hub, player_id=5)
    _, receiver_messages = joined(hub, player_id=6)
    hub.receive(sender, json.dumps({**STATE, "player_id": 6}))
    peer = receiver_messages[-1]
    assert peer["type"] == "peer"
    assert peer["player_id"] == 5
    assert peer["device_id"] == sender.device_id
    assert {key: peer[key] for key in ("x", "y", "sprite", "flags", "input", "frame")} == {
        key: STATE[key] for key in ("x", "y", "sprite", "flags", "input", "frame")
    }
    assert all(message["type"] != "peer" for message in sender_messages)


def test_player_id_collision_gets_a_different_id() -> None:
    hub = MultiplayerHub()
    _, first = joined(hub, player_id=9)
    _, second = joined(hub, player_id=9)
    assert first[0]["player_id"] == 9
    assert second[0]["player_id"] not in (0, 9)


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("{not json", "invalid_json"),
        ("[1, 2]", "invalid_message"),
        ('{"type": "dance"}', "unknown_type"),
        ('{"type": "join", "signature": "bad signature!"}', "invalid_signature"),
        ('{"type": "join", "signature": "ok", "player_id": 0}', "invalid_player_id"),
        ('{"type": "join", "signature": "ok", "flags": -1}', "invalid_flags"),
        ('{"type": "join", "signature": "ok", "device_id": ""}', "invalid_device_id"),
        (json.dumps({**STATE, "input": 128}), "invalid_input"),
        (json.dumps({**STATE, "x": "1"}), "invalid_x"),
        (json.dumps({**STATE, "frame": 1.5}), "invalid_frame"),
        (json.dumps({**STATE, "sprite": True}), "invalid_sprite"),
        ("x" * 2000, "message_too_large"),
    ],
)
def test_validation_error_codes(raw: str, code: str) -> None:
    with pytest.raises(ProtocolError) as excinfo:
        parse_message(raw)
    assert excinfo.value.code == code


def test_state_before_join_and_binary_frames() -> None:
    hub = MultiplayerHub()
    messages: list[dict] = []
    peer = hub.connect(messages.append)
    assert hub.receive(peer, json.dumps(STATE)) is True
    assert messages[-1]["code"] == "join_required"
    assert hub.receive(peer, b"\x00\x01") is True
    assert messages[-1]["code"] == "binary_not_supported"
    assert hub.receive(peer, '{"type": "leave"}') is True  # idempotent no-op


def test_ping_pong() -> None:
    hub = MultiplayerHub()
    messages: list[dict] = []
    peer = hub.connect(messages.append)
    hub.receive(peer, '{"type": "ping"}')
    assert messages[-1]["type"] == "pong"
    assert isinstance(messages[-1]["time"], int)


def test_leave_is_broadcast_and_room_removed() -> None:
    hub = MultiplayerHub()
    first, _ = joined(hub, player_id=1)
    second, second_messages = joined(hub, player_id=2)
    hub.receive(first, '{"type": "leave"}')
    assert second_messages[-1] == {"type": "leave", "player_id": 1}
    hub.disconnect(second)
    assert hub.status()["rooms"] == {}


def test_room_full() -> None:
    hub = MultiplayerHub(max_peers=1)
    joined(hub)
    _, messages = joined(hub)
    assert messages[-1]["code"] == "room_full"


def test_rate_limit_closes_with_policy_code() -> None:
    hub = MultiplayerHub(max_messages_per_second=3)
    messages: list[dict] = []
    peer = hub.connect(messages.append)
    results = [hub.receive(peer, '{"type": "ping"}') for _ in range(4)]
    assert results == [True, True, True, False]
    assert messages[-1]["code"] == "rate_limited"
    assert peer.close_code == 1008


def test_status_and_info_endpoints(tmp_path) -> None:
    from cartridge_store import create_app

    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    client = app.test_client()
    status = client.get("/api/multiplayer/status").get_json()["multiplayer"]
    assert status["protocol"] == PROTOCOL
    assert status["max_message_bytes"] == 1024
    info = client.get("/api/multiplayer").get_json()
    assert info["protocol_id"] == PROTOCOL
    assert "join" in info["protocol"]
    discovery = client.get("/.well-known/prg32-store.json").get_json()
    assert discovery["protocols"]["multiplayer"] == PROTOCOL
