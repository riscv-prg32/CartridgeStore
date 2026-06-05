from __future__ import annotations

import io
import json
import zipfile

import pytest

from cartridge_store import create_app
from tests.test_prg32_format import PNG_1X1, fake_cart, colophon, metadata


@pytest.fixture()
def client(tmp_path):
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    test_client = app.test_client()
    login_default_admin(test_client)
    return test_client


def login_default_admin(client) -> None:
    response = client.post(
        "/auth/login",
        data={"username": "admin", "password": "password"},
    )
    assert response.status_code in (200, 302)


def register(client, email: str, password: str = "longpassword") -> None:
    response = client.post(
        "/auth/register",
        data={"email": email},
    )
    assert response.status_code == 200
    token = client.application.extensions["prg32_last_registration"]["token"]
    complete = client.post(
        "/auth/register/complete",
        data={"token": token, "password": password, "password_confirm": password},
    )
    assert complete.status_code in (200, 302)


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
        "colophon": colophon(),
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


def upload_bundle(client, path: str = "/api/publish/bundle"):
    return client.post(
        path,
        data={"bundle": (io.BytesIO(bundle_bytes()), "bundle.zip")},
        content_type="multipart/form-data",
    )


def verify_submission(client, submission_id: int, metadata_updates: dict | None = None):
    return client.post(
        f"/api/submissions/{submission_id}/verify",
        json={"metadata": metadata_updates or {}},
    )


def test_publish_list_and_download(client) -> None:
    response = upload_bundle(client)
    assert response.status_code == 200
    assert response.get_json()["status"] == "pending"
    assert client.get("/api/games").get_json()["games"] == []

    verified = verify_submission(client, response.get_json()["submission_id"])
    assert verified.status_code == 200

    games = client.get("/api/games").get_json()
    assert games["ok"] is True
    assert games["games"][0]["id"] == "org.example.test"

    download = client.get("/api/games/org.example.test/download?architecture=esp32c6")
    assert download.status_code == 200
    assert download.data.startswith(b"PRG2")
    assert b"PRG32META" in download.data


def test_colophon_endpoint(client) -> None:
    submission = upload_bundle(client).get_json()
    verify_submission(client, submission["submission_id"])

    response = client.get("/api/games/org.example.test/colophon")
    assert response.status_code == 200
    body = response.get_json()
    assert body["colophon"]["abi"] == "prg32-colophon-1.0"
    assert body["colophon"]["title"] == "Test Game"


def test_multiple_architectures_share_game_version(client) -> None:
    response = upload_bundle(client)
    assert response.status_code == 200
    verify_submission(client, response.get_json()["submission_id"])

    game = client.get("/api/games/org.example.test").get_json()["game"]
    assert game["versions"] == ["1.0.0"]
    assert game["architectures"] == ["esp32c6", "qemu"]


def test_bundle_publish_two_architectures(client) -> None:
    response = upload_bundle(client)

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "pending"
    assert body["review_required"] is True
    assert {item["architecture"] for item in body["submitted"]} == {"qemu", "esp32c6"}
    assert client.get("/api/games").get_json()["games"] == []

    verify_submission(client, body["submission_id"])
    game = client.get("/api/games/org.example.test").get_json()["game"]
    assert game["architectures"] == ["esp32c6", "qemu"]


def test_api_publish_alias_accepts_bundle_package(client) -> None:
    response = upload_bundle(client, path="/api/publish")

    assert response.status_code == 200
    assert response.get_json()["legacy_endpoint"] is True
    assert response.get_json()["status"] == "pending"


def test_legacy_per_field_publish_is_rejected(client) -> None:
    response = client.post(
        "/api/publish",
        data=publish_payload("esp32c6"),
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert "package upload required" in response.get_json()["error"]


def test_editor_can_change_metadata_but_not_identity(client) -> None:
    response = upload_bundle(client)
    submission_id = response.get_json()["submission_id"]

    verified = verify_submission(
        client,
        submission_id,
        {"title": "Reviewed Title", "id": "org.bad", "version": "9.9.9", "authors": []},
    )

    assert verified.status_code == 400
    clean = verify_submission(client, submission_id, {"title": "Reviewed Title"})
    assert clean.status_code == 200
    game = client.get("/api/games/org.example.test").get_json()["game"]
    assert game["title"] == "Reviewed Title"
    assert game["id"] == "org.example.test"
    assert game["selected_version"] == "1.0.0"
    assert game["authors"] == [{"name": "PRG32"}]


def test_non_editor_cannot_verify_submission(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    client = app.test_client()
    login_default_admin(client)
    register(client, "student@example.com")

    response = upload_bundle(client)
    submission_id = response.get_json()["submission_id"]
    blocked = verify_submission(client, submission_id)
    assert blocked.status_code == 403

    client.post("/auth/login", data={"username": "admin", "password": "password"})
    assert verify_submission(client, submission_id).status_code == 200


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
        data={"bundle": (io.BytesIO(bundle_bytes()), "bundle.zip")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 401


def test_discovery_document(client) -> None:
    response = client.get("/.well-known/prg32-store.json")

    assert response.status_code == 200
    body = response.get_json()
    assert body["abi"] == "prg32-store-discovery-1.0"
    assert body["name"] == "PRG32 Cartridge Store"
    assert body["services"]["bundle_publish"].endswith("/api/publish/bundle")
