"""Regression tests for bugs fixed after review."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock

import pytest

from cartridge_store import create_app, prg32_format as fmt
from cartridge_store.auth import upsert_external_user
from cartridge_store.charts import _color
from cartridge_store.store import GameStore, latest_version, version_sort_key
from tests.test_api import login_default_admin, register
from tests.test_prg32_format import PNG_1X1, colophon, fake_cart, metadata


def make_app(tmp_path):
    return create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data")})


def test_renamed_default_admin_is_not_resurrected(tmp_path) -> None:
    app = make_app(tmp_path)
    client = app.test_client()
    login_default_admin(client)
    response = client.post(
        "/admin/users/1",
        data={"username": "root", "email": "root@example.org", "role": "admin"},
    )
    assert response.status_code == 302

    fresh = app.test_client()
    login = fresh.post("/auth/login", data={"username": "admin", "password": "password"})
    assert login.status_code == 401
    with app.app_context():
        from cartridge_store.database import get_db

        count = get_db().execute("SELECT COUNT(*) FROM users WHERE username = 'admin'").fetchone()[0]
    assert count == 0


def test_duplicate_admin_user_is_a_client_error(tmp_path) -> None:
    client = make_app(tmp_path).test_client()
    login_default_admin(client)
    response = client.post(
        "/admin/users",
        data={"username": "admin", "email": "other@example.org", "role": "user"},
    )
    assert response.status_code == 400
    assert response.get_json()["ok"] is False


def test_editors_group_cannot_be_renamed(tmp_path) -> None:
    app = make_app(tmp_path)
    client = app.test_client()
    login_default_admin(client)
    with app.app_context():
        from cartridge_store.database import get_db

        editors_id = get_db().execute("SELECT id FROM groups WHERE name = 'editors'").fetchone()[0]
    client.post(f"/admin/groups/{editors_id}", data={"name": "renamed"})
    with app.app_context():
        from cartridge_store.database import get_db

        name = get_db().execute("SELECT name FROM groups WHERE id = ?", (editors_id,)).fetchone()[0]
    assert name == "editors"


def test_external_login_does_not_link_by_username(tmp_path) -> None:
    app = make_app(tmp_path)
    app.test_client().get("/")
    with app.test_request_context("/"):
        user_id = upsert_external_user(
            provider="oidc",
            external_id="sub-1",
            email="mallory@example.org",
            username="admin",
        )
        from cartridge_store.database import get_db

        row = get_db().execute("SELECT username, role FROM users WHERE id = ?", (user_id,)).fetchone()
    assert user_id != 1
    assert row["username"] == "mallory@example.org"
    assert row["role"] == "user"


def test_owned_run_cannot_be_hijacked_or_read_anonymously(tmp_path) -> None:
    app = make_app(tmp_path)
    owner = app.test_client()
    register(owner, "student@example.org")
    created = owner.post(
        "/api/runs",
        json={"run_id": "private-run", "board_id": "b1", "target": "esp32c6"},
    )
    assert created.status_code == 200

    anon = app.test_client()
    hijack = anon.post(
        "/api/runs",
        json={"run_id": "private-run", "board_id": "evil", "target": "qemu"},
    )
    assert hijack.status_code == 403
    batch = anon.post(
        "/api/metrics/batch",
        json={"run_id": "private-run", "samples": [{"frame": 1, "frame_us": 1}]},
    )
    assert batch.status_code == 403
    assert anon.post("/api/runs/private-run/finish", json={}).status_code == 403
    assert anon.get("/api/runs/private-run/samples.csv").status_code == 403
    assert anon.get("/api/runs/private-run/report.md").status_code == 403
    assert [run["run_id"] for run in anon.get("/api/runs").get_json()] == []

    assert owner.post(
        "/api/metrics/batch",
        json={"run_id": "private-run", "samples": [{"frame": 1, "frame_us": 1}]},
    ).get_json()["inserted"] == 1
    assert [run["run_id"] for run in owner.get("/api/runs").get_json()] == ["private-run"]


def test_version_ordering_is_natural() -> None:
    assert latest_version(["1.9.0", "1.10.0", "1.2.0"]) == "1.10.0"
    assert sorted(["1.10.0", "1.9.0", "1.2.0"], key=version_sort_key) == ["1.2.0", "1.9.0", "1.10.0"]


def _publish(
    store: GameStore,
    version: str,
    title: str,
    game_id: str = "org.example.test",
) -> None:
    meta = metadata()
    meta.update({"id": game_id, "version": version, "title": title})
    image = fmt.build_cartridge(
        fake_cart(),
        metadata=meta,
        icon=PNG_1X1,
        colophon=colophon(),
        architecture="esp32c6",
    )
    store.publish(image, fmt.parse_cartridge(image), architecture="esp32c6")


def test_republishing_older_version_keeps_latest(tmp_path) -> None:
    store = GameStore(tmp_path / "data")
    _publish(store, "1.10.0", "New Title")
    _publish(store, "1.9.0", "Old Title")
    game = store.public_game("org.example.test")
    assert game["latest_version"] == "1.10.0"
    assert game["title"] == "New Title"
    assert game["versions"] == ["1.9.0", "1.10.0"]

    store.delete_variant("org.example.test", "1.10.0")
    assert store.public_game("org.example.test")["latest_version"] == "1.9.0"


def test_catalog_mutations_do_not_overwrite_each_other(tmp_path) -> None:
    store = GameStore(tmp_path / "data")
    _publish(store, "1.0.0", "Keep", "org.example.keep")
    _publish(store, "1.0.0", "Delete", "org.example.delete")

    update_is_saving = Event()
    allow_update_to_finish = Event()
    delete_started = Event()
    original_save_index = store.save_index
    save_calls_lock = Lock()
    update_save_seen = False

    def delayed_save(index) -> None:
        nonlocal update_save_seen
        should_wait = False
        with save_calls_lock:
            keep = index["games"]["org.example.keep"]
            if keep["title"] == "Updated" and not update_save_seen:
                update_save_seen = True
                should_wait = True
        if should_wait:
            update_is_saving.set()
            assert allow_update_to_finish.wait(timeout=2)
        original_save_index(index)

    store.save_index = delayed_save

    with ThreadPoolExecutor(max_workers=2) as executor:
        update = executor.submit(
            store.update_metadata,
            "org.example.keep",
            "1.0.0",
            title="Updated",
            summary="",
            tags=[],
        )
        assert update_is_saving.wait(timeout=2)

        def delete_game() -> None:
            delete_started.set()
            store.delete_variant("org.example.delete", "1.0.0")

        delete = executor.submit(delete_game)
        assert delete_started.wait(timeout=2)
        with pytest.raises(TimeoutError):
            delete.result(timeout=0.1)
        allow_update_to_finish.set()
        update.result(timeout=2)
        delete.result(timeout=2)

    assert store.public_game("org.example.keep")["title"] == "Updated"
    assert "org.example.delete" not in {
        game["id"] for game in store.list_games()
    }


def test_bundle_with_unsafe_id_is_rejected_at_submission(tmp_path) -> None:
    import io
    import json

    from tests.test_api import bundle_bytes

    client = make_app(tmp_path).test_client()
    login_default_admin(client)
    manifest = json.loads(
        __import__("zipfile").ZipFile(io.BytesIO(bundle_bytes())).read("manifest.json")
    )
    manifest["id"] = "../escape"
    response = client.post(
        "/api/publish/bundle",
        data={"bundle": (io.BytesIO(bundle_bytes(manifest=manifest)), "game.zip")},
    )
    assert response.status_code == 400
    assert "invalid game id" in response.get_json()["error"]


def test_chart_color_rejects_markup() -> None:
    assert _color('#"/><s') == "#1a73e8"
    assert _color("#abc") == "#abc"
    assert _color("#A1B2C3") == "#A1B2C3"


def test_gunicorn_config_leaves_threads_for_websockets() -> None:
    import runpy
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    config = runpy.run_path(str(root / "gunicorn.conf.py"))
    # Rooms live in memory: a second worker would split players apart.
    assert config["workers"] == 1
    # Each open WebSocket holds a thread; a full room must not starve HTTP.
    assert config["threads"] > 4 * 8
    assert config["bind"].endswith(":5080")
    assert '"--config", "gunicorn.conf.py"' in (root / "Dockerfile").read_text()
