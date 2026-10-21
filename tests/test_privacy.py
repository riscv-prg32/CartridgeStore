from __future__ import annotations

from cartridge_store import create_app
from cartridge_store.database import get_db
from tests.test_api import register


def test_privacy_notice_and_security_headers(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    client = app.test_client()

    response = client.get("/privacy")

    assert response.status_code == 200
    assert b"Privacy notice" in response.data
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_user_can_export_and_erase_personal_data(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    client = app.test_client()
    register(client, "privacy@example.test")

    exported = client.get("/api/me/export")

    assert exported.status_code == 200
    assert exported.headers["Cache-Control"] == "no-store, private"
    payload = exported.get_json()
    assert payload["format"] == "prg32-cartridge-store-data-export-1.0"
    assert payload["account"]["email"] == "privacy@example.test"
    assert payload["account"]["privacy_notice_version"]

    erased = client.post("/account/delete", data={"confirmation": "DELETE"})

    assert erased.status_code == 302
    with app.app_context():
        assert get_db().execute(
            "SELECT 1 FROM users WHERE email = 'privacy@example.test'"
        ).fetchone() is None
        assert get_db().execute(
            "SELECT event_type FROM privacy_events WHERE event_type = 'erasure'"
        ).fetchone() is not None


def test_last_admin_cannot_self_erase(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    client = app.test_client()
    client.post("/auth/login", data={"username": "admin", "password": "password"})

    response = client.post("/account/delete", data={"confirmation": "DELETE"})

    assert response.status_code == 400
    assert b"last administrator" in response.data
