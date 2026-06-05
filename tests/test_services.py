from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import patch

from cartridge_store import create_app
from cartridge_store.export_run import export_run
from cartridge_store.multiplayer import MultiplayerHub
from tests.test_prg32_format import PNG_1X1, colophon, fake_cart, metadata


def make_client(tmp_path):
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    return app.test_client()


def publish_payload(architecture: str = "esp32c6") -> dict:
    return {
        "architecture": architecture,
        "metadata": json.dumps(metadata()),
        "colophon": json.dumps(colophon()),
        "cartridge": (io.BytesIO(fake_cart()), "game.prg32"),
        "icon": (io.BytesIO(PNG_1X1), "icon.png"),
    }


def post_metrics_run(client, run_id: str = "test-run"):
    return client.post(
        "/api/runs",
        json={
            "run_id": run_id,
            "board_id": "board-1",
            "target": "esp32c6",
            "display_backend": "ili9341",
            "firmware_version": "test",
            "firmware_git_sha": "abc123",
            "game_name": "pong",
            "sample_period_frames": 1,
            "started_ms": 1000,
        },
    )


def sample_payload() -> dict:
    return {
        "frame": 1,
        "timestamp_ms": 1033,
        "update_us": 500,
        "draw_us": 6000,
        "present_us": 17000,
        "frame_us": 23500,
        "heap_free": 123456,
        "heap_min_free": 120000,
        "input_mask": 0,
        "fps_x100": 4255,
        "upload_queue_depth": 1,
        "deadline_missed": False,
    }


def test_score_api_round_trip(tmp_path) -> None:
    client = make_client(tmp_path)

    posted = client.post(
        "/api/scores",
        json={"game": "pong", "player": "Ada", "score": 42},
    )
    assert posted.status_code == 200
    assert posted.get_json() == {"ok": True}

    listed = client.get("/api/scores?game=pong&limit=5")
    assert listed.status_code == 200
    scores = listed.get_json()
    assert scores[0]["game"] == "pong"
    assert scores[0]["player"] == "Ada"
    assert scores[0]["score"] == 42
    assert scores[0]["submitted_by"] == "anonymous"


def test_metrics_api_round_trip_and_export(tmp_path) -> None:
    client = make_client(tmp_path)

    run = post_metrics_run(client)
    assert run.status_code == 200, run.get_json()

    batch = client.post(
        "/api/metrics/batch",
        json={"run_id": "test-run", "dropped_samples": 1, "samples": [sample_payload()]},
    )
    assert batch.status_code == 200, batch.get_json()
    assert batch.get_json()["inserted"] == 1

    duplicate = client.post(
        "/api/metrics/batch",
        json={"run_id": "test-run", "samples": [{"frame": 1}]},
    )
    assert duplicate.status_code == 200, duplicate.get_json()
    assert duplicate.get_json()["inserted"] == 0

    detail = client.get("/api/runs/test-run")
    assert detail.status_code == 200, detail.get_json()
    assert detail.get_json()["summary"]["sample_count"] == 1

    csv_response = client.get("/api/runs/test-run/samples.csv")
    assert csv_response.status_code == 200
    assert "frame_us" in csv_response.text
    assert "23500" in csv_response.text

    finish = client.post(
        "/api/runs/test-run/finish",
        json={"finished_ms": 2000, "dropped_samples": 2},
    )
    assert finish.status_code == 200, finish.get_json()

    report = client.get("/api/runs/test-run/report.md")
    assert report.status_code == 200
    assert "# PRG32 Metrics Report" in report.text
    assert "Dropped samples: 2" in report.text

    db_path = Path(client.application.config["DATABASE"])
    out_dir = tmp_path / "export"
    with patch.dict("os.environ", {"PRG32_METRICS_SKIP_PLOTS": "1"}):
        export_run(db_path, "test-run", out_dir)
    assert (out_dir / "metadata.json").exists()
    assert (out_dir / "samples.csv").exists()
    assert (out_dir / "summary.csv").exists()
    assert (out_dir / "table_summary.tex").exists()
    assert "PRG32 Metrics Report" in (out_dir / "report.md").read_text()


def test_metrics_missing_run_is_rejected(tmp_path) -> None:
    client = make_client(tmp_path)

    response = client.post(
        "/api/metrics/batch",
        json={"run_id": "missing", "samples": []},
    )
    assert response.status_code == 404


def test_multiplayer_hub_relays_same_signature() -> None:
    hub = MultiplayerHub(max_peers=4)
    first_messages = []
    second_messages = []
    first = hub.connect(first_messages.append)
    second = hub.connect(second_messages.append)

    hub.receive(first, {"type": "join", "signature": "pong-v1", "player_id": 11})
    hub.receive(second, {"type": "join", "signature": "pong-v1", "player_id": 22})
    hub.receive(
        first,
        {
            "type": "state",
            "x": 120,
            "y": 80,
            "sprite": 1,
            "flags": 2,
            "input": 3,
            "frame": 42,
        },
    )

    assert first_messages[0] == {"type": "welcome", "player_id": 11}
    assert second_messages[0] == {"type": "welcome", "player_id": 22}
    assert second_messages[-1] == {
        "type": "peer",
        "player_id": 11,
        "x": 120,
        "y": 80,
        "sprite": 1,
        "flags": 2,
        "input": 3,
        "frame": 42,
    }


def test_multiplayer_hub_cleans_stale_peer_on_broadcast() -> None:
    hub = MultiplayerHub(max_peers=4)
    first_messages = []
    stale_messages = []
    first = hub.connect(first_messages.append)

    def stale_send(message):
        stale_messages.append(message)
        if len(stale_messages) > 1:
            raise RuntimeError("closed")

    stale = hub.connect(stale_send)

    hub.receive(first, {"type": "join", "signature": "pong-v1", "player_id": 11})
    hub.receive(stale, {"type": "join", "signature": "pong-v1", "player_id": 22})

    hub.leave(first)

    assert hub.status()["rooms"] == {}
    assert stale.player_id == 0


def test_unified_roles_gate_writes_when_configured(tmp_path) -> None:
    app = create_app(
        {
            "TESTING": True,
            "DATA_DIR": str(tmp_path / "data"),
            "USERS": [
                {"name": "board", "role": "player", "token": "board-secret"},
                {"name": "teacher", "role": "publisher", "token": "teach-secret"},
            ],
        }
    )
    client = app.test_client()

    missing = client.post(
        "/api/scores",
        json={"game": "pong", "player": "Ada", "score": 42},
    )
    assert missing.status_code == 401

    score = client.post(
        "/api/scores",
        headers={"Authorization": "Bearer board-secret"},
        json={"game": "pong", "player": "Ada", "score": 42},
    )
    assert score.status_code == 200

    blocked_publish = client.post(
        "/api/publish",
        headers={"Authorization": "Bearer board-secret"},
        data=publish_payload("esp32c6"),
        content_type="multipart/form-data",
    )
    assert blocked_publish.status_code == 403

    allowed_publish = client.post(
        "/api/publish",
        headers={"Authorization": "Bearer teach-secret"},
        data=publish_payload("esp32c6"),
        content_type="multipart/form-data",
    )
    assert allowed_publish.status_code == 200, allowed_publish.get_json()
    assert allowed_publish.get_json()["game"]["publisher"] == "teacher"

    me = client.get("/api/me", headers={"Authorization": "Bearer teach-secret"})
    assert me.get_json()["user"] == {
        "name": "teacher",
        "role": "publisher",
        "authenticated": True,
    }


def test_multiplayer_requires_player_role_when_configured(tmp_path) -> None:
    app = create_app(
        {
            "TESTING": True,
            "DATA_DIR": str(tmp_path / "data"),
            "USERS": [{"name": "board", "role": "player", "token": "board-secret"}],
        }
    )
    hub = app.extensions["prg32_multiplayer_hub"]
    messages = []
    peer = hub.connect(messages.append)

    hub.receive(peer, {"type": "join", "signature": "pong-v1"})
    assert messages[-1]["error"] == "player role required"

    hub.receive(peer, {"type": "join", "signature": "pong-v1", "token": "board-secret"})
    assert messages[-1] == {"type": "welcome", "player_id": 1}


def test_discovery_lists_unified_services_and_roles(tmp_path) -> None:
    client = make_client(tmp_path)

    response = client.get("/.well-known/prg32-store.json")

    assert response.status_code == 200
    body = response.get_json()
    services = body["services"]
    assert services["scores"].endswith("/api/scores")
    assert services["metrics"].endswith("/api/runs")
    assert services["multiplayer"].endswith("/api/multiplayer")
    assert "player" in body["roles"]
