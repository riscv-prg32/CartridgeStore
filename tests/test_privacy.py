from __future__ import annotations

from cartridge_store import create_app
from cartridge_store.database import get_db
from cartridge_store.auth import init_auth_db
from cartridge_store.store import GameStore
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

    erased = client.post(
        "/account/delete",
        data={"confirmation": "DELETE", "password": "longpassword"},
    )

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

    response = client.post(
        "/account/delete",
        data={"confirmation": "DELETE", "password": "password"},
    )

    assert response.status_code == 400
    assert b"last administrator" in response.data


def test_email_is_not_exposed_as_public_identity(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    user = app.test_client()
    register(user, "student@example.test")
    me = user.get("/api/me").get_json()["user"]
    assert me["username"].startswith("player-")
    assert "@" not in me["username"]

    assert user.post(
        "/api/scores", json={"game": "pong", "player": "Ada", "score": 7}
    ).status_code == 200
    public = app.test_client()
    scores = public.get("/api/scores").get_json()
    assert scores[0]["submitted_by"] == me["username"]
    assert "student@example.test" not in public.get("/api/scores").text
    assert public.get("/users/student@example.test").status_code == 404
    assert public.get(f"/users/{me['username']}").status_code == 200


def test_existing_email_username_gets_safe_public_handle(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    client = app.test_client()
    client.get("/")
    with app.app_context():
        db = get_db()
        db.execute("DROP INDEX users_public_handle_idx")
        db.execute("UPDATE users SET username = email, public_handle = NULL WHERE id = 1")
        db.commit()
        init_auth_db()
        row = db.execute("SELECT public_handle FROM users WHERE id = 1").fetchone()
        assert row["public_handle"] == "player-000001"


def test_erasure_anonymises_reviewer_and_catalog_publisher(tmp_path) -> None:
    data_dir = tmp_path / "data"
    app = create_app({"TESTING": True, "DATA_DIR": str(data_dir)})
    user = app.test_client()
    register(user, "eraseme@example.test")
    me = user.get("/api/me").get_json()["user"]
    with app.app_context():
        db = get_db()
        db.execute(
            "INSERT INTO cartridge_submissions(game_id, version, status, reviewed_by_user_id, reviewed_by, metadata_json, architectures_json) VALUES ('game', '1', 'verified', ?, ?, '{}', '[]')",
            (me["id"], me["username"]),
        )
        db.commit()
    store = GameStore(data_dir)
    store.save_index({
        "games": {"game": {"id": "game", "publisher": me["username"], "latest_version": "1", "versions": {"1": {"version": "1", "published_by": me["username"], "metadata": {}, "architectures": {}}}}}
    })

    response = user.post(
        "/account/delete",
        data={"confirmation": "DELETE", "password": "longpassword"},
    )
    assert response.status_code == 302
    with app.app_context():
        reviewed_by = get_db().execute("SELECT reviewed_by FROM cartridge_submissions").fetchone()["reviewed_by"]
        assert reviewed_by == "deleted user"
    assert store.load_index()["games"]["game"]["publisher"] == "deleted user"


def test_browser_forms_require_csrf_when_enabled(tmp_path) -> None:
    app = create_app({
        "TESTING": True,
        "CSRF_ENABLED": True,
        "DATA_DIR": str(tmp_path / "data"),
    })
    client = app.test_client()
    assert client.get("/auth/login").status_code == 200
    assert client.post(
        "/auth/login", data={"username": "admin", "password": "password"}
    ).status_code == 400
    with client.session_transaction() as browser_session:
        token = browser_session["csrf_token"]
    assert client.post(
        "/auth/login",
        data={"username": "admin", "password": "password", "csrf_token": token},
    ).status_code == 302


def test_export_requires_recent_authentication(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    client = app.test_client()
    register(client, "recent@example.test")
    with client.session_transaction() as browser_session:
        browser_session["authenticated_at"] = 0
    assert client.get("/api/me/export").status_code == 403


def test_admin_cleanup_requires_recent_authentication(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    client = app.test_client()
    client.post("/auth/login", data={"username": "admin", "password": "password"})
    with client.session_transaction() as browser_session:
        browser_session["authenticated_at"] = 0
    response = client.post("/admin/privacy/cleanup")
    assert response.status_code == 403
    assert response.get_json()["error"] == "recent authentication required"


def test_privacy_cleanup_cli_supports_dry_run(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    result = app.test_cli_runner().invoke(args=["privacy-cleanup", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert '"download_events": 0' in result.output


def test_public_handle_rejects_email_address(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    client = app.test_client()
    client.post("/auth/register", data={"email": "handle@example.test"})
    token = app.extensions["prg32_last_registration"]["token"]
    response = client.post(
        "/auth/register/complete",
        data={
            "token": token,
            "public_handle": "handle@example.test",
            "password": "longpassword",
            "password_confirm": "longpassword",
        },
    )
    assert response.status_code == 400
    assert b"public handle" in response.data


def test_bearer_json_api_does_not_require_browser_csrf(tmp_path) -> None:
    app = create_app({
        "TESTING": True,
        "CSRF_ENABLED": True,
        "DATA_DIR": str(tmp_path / "data"),
    })
    browser = app.test_client()
    browser.get("/auth/login")
    with browser.session_transaction() as browser_session:
        csrf = browser_session["csrf_token"]
    browser.post(
        "/auth/login",
        data={"username": "admin", "password": "password", "csrf_token": csrf},
    )
    created = browser.post("/auth/tokens", json={"label": "test"}).get_json()
    api = app.test_client()
    response = api.post(
        "/api/scores",
        headers={"Authorization": f"Bearer {created['token']}"},
        json={"game": "pong", "player": "Ada", "score": 9},
    )
    assert response.status_code == 200
