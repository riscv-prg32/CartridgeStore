from __future__ import annotations

import io
import json

import pytest

from cartridge_store import create_app
from tests.test_prg32_format import PNG_1X1, fake_cart, colophon, metadata


@pytest.fixture()
def client(tmp_path):
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


def test_publish_list_and_download(client) -> None:
    response = client.post(
        "/api/publish",
        data=publish_payload("esp32c6"),
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    assert response.get_json()["game"]["architectures"] == ["esp32c6"]

    games = client.get("/api/games").get_json()
    assert games["ok"] is True
    assert games["games"][0]["id"] == "org.example.test"

    download = client.get("/api/games/org.example.test/download?architecture=esp32c6")
    assert download.status_code == 200
    assert download.data.startswith(b"PRG2")
    assert b"PRG32META" in download.data


def test_colophon_endpoint(client) -> None:
    client.post(
        "/api/publish",
        data=publish_payload("esp32c6"),
        content_type="multipart/form-data",
    )

    response = client.get("/api/games/org.example.test/colophon")
    assert response.status_code == 200
    body = response.get_json()
    assert body["colophon"]["abi"] == "prg32-colophon-1.0"
    assert body["colophon"]["title"] == "Test Game"


def test_multiple_architectures_share_game_version(client) -> None:
    first = client.post(
        "/api/publish",
        data=publish_payload("esp32c6"),
        content_type="multipart/form-data",
    )
    assert first.status_code == 200

    second = client.post(
        "/api/publish",
        data=publish_payload("qemu"),
        content_type="multipart/form-data",
    )
    assert second.status_code == 200

    game = client.get("/api/games/org.example.test").get_json()["game"]
    assert game["versions"] == ["1.0.0"]
    assert game["architectures"] == ["esp32c6", "qemu"]


def test_discovery_document(client) -> None:
    response = client.get("/.well-known/prg32-store.json")

    assert response.status_code == 200
    body = response.get_json()
    assert body["abi"] == "prg32-store-discovery-1.0"
    assert body["name"] == "PRG32 Cartrige Store"
