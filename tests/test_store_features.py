"""Featured cartridges, preview videos, admin logs and statistics, privacy."""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from cartridge_store import create_app
from tests.test_api import bundle_bytes, login_default_admin, publish_verified_game, verify_submission
from tests.test_prg32_format import PNG_1X1, colophon, fake_cart, metadata


# Smallest useful MP4 header: a 'ftyp' box followed by filler bytes.
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 64


@pytest.fixture()
def client(tmp_path):
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    test_client = app.test_client()
    login_default_admin(test_client)
    return test_client


def preview_bundle(*, preview: bytes = MP4, name: str = "preview.mp4", manifest_preview: str | None = None) -> bytes:
    manifest = {
        **metadata(),
        "id": "org.example.video",
        "title": "Video Game",
        "assets": {"icon": "icon.png"},
        "architectures": [{"id": "esp32c6", "file": "game-esp32c6.prg32"}],
        "colophon": colophon(),
    }
    if manifest_preview:
        manifest["assets"]["preview"] = manifest_preview
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("icon.png", PNG_1X1)
        zf.writestr("game-esp32c6.prg32", fake_cart())
        zf.writestr(name, preview)
    return output.getvalue()


def upload(client, data: bytes):
    return client.post(
        "/api/publish/bundle",
        data={"bundle": (io.BytesIO(data), "bundle.zip")},
        content_type="multipart/form-data",
    )


def test_preview_video_flows_from_bundle_to_game_page(client) -> None:
    response = upload(client, preview_bundle())
    assert response.status_code == 200, response.get_json()
    body = response.get_json()
    assert body["preview"] is True

    pending = client.get(f"/editor/submissions/{body['submission_id']}/preview")
    assert pending.status_code == 200
    assert pending.data == MP4

    assert verify_submission(client, body["submission_id"]).status_code == 200
    game = client.get("/api/games/org.example.video").get_json()["game"]
    assert game["has_preview"] is True
    assert game["preview"]["size"] == len(MP4)
    assert "filename" not in game["preview"]

    video = client.get("/api/games/org.example.video/preview")
    assert video.status_code == 200
    assert video.mimetype == "video/mp4"
    assert video.data == MP4
    ranged = client.get("/api/games/org.example.video/preview", headers={"Range": "bytes=0-7"})
    assert ranged.status_code == 206
    assert ranged.data == MP4[:8]

    page = client.get("/games/org.example.video")
    assert "<video controls" in page.text
    assert "autoplay" not in page.text
    assert "/api/games/org.example.video/preview" in page.text


def test_preview_named_in_manifest_and_validated(client) -> None:
    named = upload(client, preview_bundle(name="media/gameplay.mp4", manifest_preview="media/gameplay.mp4"))
    assert named.status_code == 200, named.get_json()
    assert named.get_json()["preview"] is True

    bad = upload(client, preview_bundle(preview=b"not a video at all"))
    assert bad.status_code == 400
    assert "MP4" in bad.get_json()["error"]


def test_game_without_preview(client) -> None:
    publish_verified_game(client, "org.example.plain", "Plain")
    assert client.get("/api/games/org.example.plain").get_json()["game"]["has_preview"] is False
    assert client.get("/api/games/org.example.plain/preview").status_code == 400
    assert "<video" not in client.get("/games/org.example.plain").text


def test_deleting_a_version_removes_its_preview(client, tmp_path) -> None:
    response = upload(client, preview_bundle())
    verify_submission(client, response.get_json()["submission_id"])
    stored = list((tmp_path / "data" / "cartridges").rglob("preview.mp4"))
    assert stored
    client.post("/admin/cartridges/org.example.video/1.0.0/delete")
    assert not any(path.exists() for path in stored)


def test_featured_lists_latest_releases(client) -> None:
    publish_verified_game(client, "org.example.old", "Old Game")
    publish_verified_game(client, "org.example.new", "New Game")
    games = client.get("/api/games").get_json()
    featured = games["featured"]
    assert [game["id"] for game in featured][:2] in (
        ["org.example.new", "org.example.old"],
        ["org.example.old", "org.example.new"],
    )
    assert all(game["featured_reason"] == "new" for game in featured)

    page = client.get("/")
    assert "Featured: latest releases" in page.text
    assert client.get("/?q=Old").text.count("Featured: latest releases") == 0


def test_admin_event_log_records_and_filters(client) -> None:
    publish_verified_game(client, "org.example.logged", "Logged")
    client.post("/admin/groups", data={"name": "teachers"})
    page = client.get("/admin/logs")
    assert page.status_code == 200
    assert "submission.verified" in page.text
    assert "group.created" in page.text
    assert page.headers["Cache-Control"] == "no-store, private"

    api = client.get("/api/admin/logs?category=admin").get_json()
    assert api["ok"] is True
    assert {event["category"] for event in api["events"]} == {"admin"}
    assert all(event["actor"] == "admin" for event in api["events"])

    csv_export = client.get("/admin/logs.csv")
    assert csv_export.mimetype == "text/csv"
    assert "group.created" in csv_export.text


def test_failed_login_is_logged_without_the_name(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    anonymous = app.test_client()
    anonymous.post("/auth/login", data={"username": "mallory@example.org", "password": "nope"})
    admin = app.test_client()
    login_default_admin(admin)
    events = admin.get("/api/admin/logs?level=WARNING").get_json()["events"]
    failed = [event for event in events if event["event"] == "login.failed"]
    assert failed
    assert "mallory" not in json.dumps(events)


def test_log_messages_are_redacted() -> None:
    from cartridge_store.logs import redact

    assert redact("mail ada@example.org link /x?token=abc123&y=1") == "mail [email] link /x?token=[redacted]&y=1"


def test_admin_pages_require_admin(tmp_path) -> None:
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    anonymous = app.test_client()
    for path in ("/admin/logs", "/api/admin/logs", "/admin/stats", "/api/admin/stats", "/admin/logs.csv"):
        # Browser pages redirect to sign-in; API answers 401.
        assert anonymous.get(path).status_code in (302, 401), path


def test_admin_statistics(client) -> None:
    publish_verified_game(client, "org.example.stats", "Stats")
    client.get(
        "/api/games/org.example.stats/download",
        headers={"User-Agent": "Mozilla/5.0 (Macintosh) Chrome/130"},
    )
    client.get("/api/games/org.example.stats/download", headers={"User-Agent": "PRG32-firmware/1.2"})
    stats = client.get("/api/admin/stats").get_json()["stats"]
    assert stats["catalog"]["games"] == 1
    assert stats["downloads"]["total"] == 2
    assert dict(stats["downloads"]["by_client"]) == {"browser": 1, "prg32": 1}
    assert stats["users"]["total"] >= 1
    assert stats["multiplayer"]["protocol"] == "prg32-multiplayer-1.0"
    page = client.get("/admin/stats")
    assert page.status_code == 200
    assert "Downloads by client" in page.text


def test_download_events_keep_only_a_client_class(client) -> None:
    from cartridge_store.database import get_db

    publish_verified_game(client, "org.example.ua", "UA")
    client.get("/api/games/org.example.ua/download", headers={"User-Agent": "curl/8.4.0"})
    with client.application.app_context():
        rows = get_db().execute("SELECT user_agent FROM download_events").fetchall()
    assert [row["user_agent"] for row in rows] == ["tool"]


def test_erasure_anonymises_log_actor_and_export_includes_events(tmp_path) -> None:
    from cartridge_store.database import get_db

    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})
    admin = app.test_client()
    login_default_admin(admin)
    admin.post(
        "/admin/users",
        data={"username": "ada", "email": "ada@example.org", "public_handle": "ada-l", "password": "longpassword"},
    )
    ada = app.test_client()
    ada.post("/auth/login", data={"username": "ada", "password": "longpassword"})
    with ada.session_transaction() as session:
        session["authenticated_at"] = 10**12
    export = ada.get("/api/me/export").get_json()
    assert any(event["event"] == "login.succeeded" for event in export["service_log_events"])

    with app.app_context():
        user_id = get_db().execute("SELECT id FROM users WHERE username = 'ada'").fetchone()["id"]
    admin.post(f"/admin/users/{user_id}/delete")
    with app.app_context():
        actors = {row["actor"] for row in get_db().execute("SELECT actor FROM app_events").fetchall()}
    assert "ada-l" not in actors
    assert "deleted user" in actors


def test_signed_in_pages_are_not_cached(client, tmp_path) -> None:
    assert client.get("/").headers["Cache-Control"] == "no-store, private"
    assert client.get("/").headers["X-PRG32-Signed-In"] == "1"
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "other")})
    public = app.test_client().get("/")
    assert "X-PRG32-Signed-In" not in public.headers


def test_accessibility_basics(client) -> None:
    publish_verified_game(client, "org.example.a11y", "A11y")
    for path in ("/", "/games/org.example.a11y", "/admin/logs", "/admin/stats", "/accessibility", "/scores", "/stats"):
        page = client.get(path)
        assert page.status_code == 200, path
        assert '<html lang="en">' in page.text
        assert 'href="#main"' in page.text and 'id="main"' in page.text
        assert page.text.count("<h1") == 1, path
    statement = client.get("/accessibility").text
    assert "WCAG" in statement


def test_setup_warns_about_low_contrast_theme(client) -> None:
    from cartridge_store.settings import contrast_with_white

    assert contrast_with_white("#1a73e8") >= 4.5
    assert contrast_with_white("#ffcc00") < 4.5
    with client.application.app_context():
        from cartridge_store.settings import set_setting

        set_setting("theme_primary_color", "#ffcc00")
    assert "WCAG AA needs at least 4.5:1" in client.get("/setup").text
