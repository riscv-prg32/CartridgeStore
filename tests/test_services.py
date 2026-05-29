from __future__ import annotations

from cartridge_store import create_app
from cartridge_store.multiplayer import MultiplayerHub


def make_client(tmp_path):
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    return app.test_client()


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


def test_metrics_api_round_trip(tmp_path) -> None:
    client = make_client(tmp_path)

    run = client.post(
        "/api/runs",
        json={
            "run_id": "test-run",
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
    assert run.status_code == 200

    batch = client.post(
        "/api/metrics/batch",
        json={
            "run_id": "test-run",
            "dropped_samples": 1,
            "samples": [
                {
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
            ],
        },
    )
    assert batch.status_code == 200
    assert batch.get_json()["inserted"] == 1

    detail = client.get("/api/runs/test-run")
    assert detail.status_code == 200
    assert detail.get_json()["summary"]["sample_count"] == 1

    csv_response = client.get("/api/runs/test-run/samples.csv")
    assert csv_response.status_code == 200
    assert "frame_us" in csv_response.text
    assert "23500" in csv_response.text

    report = client.get("/api/runs/test-run/report.md")
    assert report.status_code == 200
    assert "# PRG32 Metrics Report" in report.text


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


def test_discovery_lists_unified_services(tmp_path) -> None:
    client = make_client(tmp_path)

    response = client.get("/.well-known/prg32-store.json")

    assert response.status_code == 200
    services = response.get_json()["services"]
    assert services["scores"].endswith("/api/scores")
    assert services["metrics"].endswith("/api/runs")
    assert services["multiplayer"].endswith("/api/multiplayer")
