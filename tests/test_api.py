from __future__ import annotations

import io
import json
import sqlite3
import zipfile

import pytest

from cartridge_store import create_app
from tests.test_prg32_format import PNG_1X1, fake_cart, colophon, metadata


@pytest.fixture()
def client(tmp_path):
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    test_client = app.test_client()
    register(test_client, "admin", "admin@example.com")
    return test_client


def register(client, username: str, email: str, password: str = "longpassword") -> None:
    response = client.post(
        "/auth/register",
        data={"username": username, "email": email, "password": password},
    )
    assert response.status_code == 200


def publish_payload(architecture: str = "esp32c6") -> dict:
    return {
        "architecture": architecture,
        "metadata": json.dumps(metadata()),
        "colophon": json.dumps(colophon()),
        "cartridge": (io.BytesIO(fake_cart()), "game.prg32"),
        "icon": (io.BytesIO(PNG_1X1), "icon.png"),
    }


def bundle_bytes(
    *,
    manifest: dict | None = None,
    include_manifest: bool = True,
    include_icon: bool = True,
    include_cartridges: bool = True,
) -> bytes:
    manifest = manifest or {
        **metadata(),
        "summary": "Bundle test",
        "assets": {"icon": "icon.png"},
        "architectures": [
            {"id": "qemu", "file": "game-qemu.prg32", "variant": "assembly"},
            {"id": "esp32c6", "file": "game-esp32c6.prg32"},
        ],
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as zf:
        if include_manifest:
            zf.writestr("manifest.json", json.dumps(manifest))
        if include_icon:
            zf.writestr("icon.png", PNG_1X1)
        if include_cartridges:
            for arch in manifest.get("architectures", []):
                zf.writestr(arch.get("file", "game.prg32"), fake_cart())
    return output.getvalue()


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


def test_bundle_publish_two_architectures(client) -> None:
    response = client.post(
        "/api/publish/bundle",
        data={"bundle": (io.BytesIO(bundle_bytes()), "bundle.zip")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "ok"
    assert {item["architecture"] for item in body["published"]} == {"qemu", "esp32c6"}

    game = client.get("/api/games/org.example.test").get_json()["game"]
    assert game["architectures"] == ["esp32c6", "qemu"]


@pytest.mark.parametrize(
    ("bundle", "message"),
    [
        (lambda: bundle_bytes(include_manifest=False), "manifest.json"),
        (
            lambda: bundle_bytes(manifest={**metadata(), "abi": "wrong", "assets": {"icon": "icon.png"}, "architectures": [{"id": "qemu", "file": "game-qemu.prg32"}]}),
            "manifest.abi",
        ),
        (
            lambda: bundle_bytes(manifest={**metadata(), "assets": {"icon": "icon.png"}, "architectures": []}),
            "architectures",
        ),
        (lambda: bundle_bytes(include_cartridges=False), "cartridge file"),
        (lambda: bundle_bytes(include_icon=False), "icon file"),
        (lambda: b"not a zip", "zip"),
    ],
)
def test_bundle_publish_invalid_inputs(client, bundle, message) -> None:
    response = client.post(
        "/api/publish/bundle",
        data={"bundle": (io.BytesIO(bundle()), "bundle.zip")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert message in response.get_json()["error"]


def test_publish_requires_login(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    unauthenticated = app.test_client()

    response = unauthenticated.post(
        "/api/publish",
        data=publish_payload("esp32c6"),
        content_type="multipart/form-data",
    )

    assert response.status_code == 401


def test_discovery_document(client) -> None:
    response = client.get("/.well-known/prg32-store.json")

    assert response.status_code == 200
    body = response.get_json()
    assert body["abi"] == "prg32-store-discovery-1.0"
    assert body["name"] == "PRG32 Cartrige Store"
    assert body["services"]["bundle_publish"].endswith("/api/publish/bundle")
