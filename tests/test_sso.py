"""Single sign-on and user sync with a PRG32-Construction-Kit.

The protocol is the same on both sides, so two stores linked to each other
behave like a store linked to a kit. The real kit-to-store pairing is tested in
the PRG32-Construction-Kit repository (tests/test_sso_with_cartridge_store.py).
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from cartridge_store import create_app, sso_protocol as protocol
from cartridge_store.database import get_db

SECRET = "a-shared-classroom-secret-that-is-long-enough"
PASSWORD = "student-password-1"


def make_store(path: Path, **extra):
    return create_app({"TESTING": True, "DATA_DIR": str(path), **extra})


def link(app_a, app_b, online=lambda: True):
    peer = app_b.test_client()

    def transport(method, url, headers, body):
        if not online():
            raise ConnectionError("peer is offline")
        response = peer.open(urlsplit(url).path, method=method, headers=headers, data=body)
        return response.status_code, response.data

    app_a.config["SSO_TRANSPORT"] = transport


def admin(app):
    client = app.test_client()
    assert client.post("/auth/login", data={"username": "admin", "password": "password"}).status_code == 302
    return client


def emails(app) -> dict[str, dict]:
    with app.app_context():
        rows = get_db().execute("SELECT * FROM users").fetchall()
        return {row["email"]: dict(row) for row in rows}


def user_id(app, email: str) -> int:
    return int(emails(app)[email]["id"])


@pytest.fixture()
def pair(tmp_path):
    first = make_store(tmp_path / "a", SSO_SECRET=SECRET, SSO_PEER_URL="http://b.test")
    second = make_store(tmp_path / "b", SSO_SECRET=SECRET, SSO_PEER_URL="http://a.test")
    link(first, second)
    link(second, first)
    admin(first)  # creates the schema and the default admin on both sides
    admin(second)
    return first, second


def signed_post(client, records):
    body = json.dumps({"users": records}).encode()
    headers = {**protocol.sign_request(SECRET, "POST", protocol.USERS_PATH, body), "Content-Type": "application/json"}
    return client.post(protocol.USERS_PATH, data=body, headers=headers)


def test_sso_is_off_without_a_long_secret(tmp_path):
    store = make_store(tmp_path, SSO_SECRET="short", SSO_PEER_URL="http://kit.test")
    assert store.test_client().get("/api/me").get_json()["sso"]["enabled"] is False
    assert store.test_client().get("/.well-known/prg32-store.json").get_json()["sso"]["enabled"] is False


def test_unsigned_requests_are_refused(pair):
    first, _ = pair
    client = first.test_client()
    assert client.post(protocol.USERS_PATH, json={"users": [{"email": "evil@x.test", "role": "admin"}]}).status_code == 403
    assert client.get(protocol.USERS_PATH).status_code == 403
    assert "evil@x.test" not in emails(first)


def test_admin_changes_reach_the_other_store(pair):
    first, second = pair
    client = admin(first)
    client.post("/admin/users", data={"username": "ada", "email": "ada@school.test", "password": PASSWORD,
                                      "role": "user", "groups": ["editors"]})
    copy = emails(second)["ada@school.test"]
    assert copy["username"] == "ada"
    login = second.test_client().post("/auth/login", data={"username": "ada", "password": PASSWORD})
    assert login.status_code == 302

    client.post(f"/admin/users/{user_id(first, 'ada@school.test')}/role", data={"role": "publisher"})
    assert emails(second)["ada@school.test"]["role"] == "publisher"
    client.post(f"/admin/users/{user_id(first, 'ada@school.test')}",
                data={"username": "ada", "email": "ada@new.test", "role": "publisher"})
    assert "ada@new.test" in emails(second) and "ada@school.test" not in emails(second)
    client.post(f"/admin/users/{user_id(first, 'ada@new.test')}/delete")
    assert "ada@new.test" not in emails(second)


def test_registration_reaches_the_other_store(pair):
    first, second = pair
    browser = first.test_client()
    browser.post("/auth/register", data={"email": "bob@school.test"})
    token = first.extensions["prg32_last_registration"]["token"]
    browser.post("/auth/register/complete", data={"token": token, "password": PASSWORD, "password_confirm": PASSWORD})
    assert "bob@school.test" in emails(second)


def test_changes_wait_while_the_peer_is_offline(tmp_path):
    first = make_store(tmp_path / "a", SSO_SECRET=SECRET, SSO_PEER_URL="http://b.test")
    second = make_store(tmp_path / "b", SSO_SECRET=SECRET, SSO_PEER_URL="http://a.test")
    up = {"value": False}
    link(first, second, online=lambda: up["value"])
    link(second, first)
    admin(second)
    client = admin(first)
    client.post("/admin/users", data={"username": "ada", "email": "ada@school.test", "password": PASSWORD, "role": "user"})
    assert "ada@school.test" not in emails(second)
    assert client.get("/api/me").get_json()["sso"]["enabled"] is True
    up["value"] = True
    assert client.post("/admin/sso/sync", json={}).get_json()["ok"] is True
    assert "ada@school.test" in emails(second)


def test_stale_records_and_the_last_admin_are_protected(pair):
    first, _ = pair
    client = first.test_client()
    stale = {"email": "admin@localhost", "username": "admin", "role": "user", "updated_at": "2000-01-01T00:00:00Z"}
    assert signed_post(client, [stale]).get_json()["results"] == ["stale"]
    demote = {**stale, "updated_at": protocol.timestamp_now()}
    assert signed_post(client, [demote]).get_json()["results"] == ["kept-last-admin"]
    delete = {"email": "admin@localhost", "deleted": True, "updated_at": protocol.timestamp_now()}
    assert signed_post(client, [delete]).get_json()["results"] == ["kept-last-admin"]
    assert emails(first)["admin@localhost"]["role"] == "admin"


def test_login_ticket_signs_in_once(pair):
    first, _ = pair
    ticket = protocol.make_ticket(SECRET, email="admin@localhost", audience="cartridge-store", purpose="login", ttl=60)
    browser = first.test_client()
    response = browser.post("/auth/sso/accept", data={"ticket": ticket, "next": "/publish"})
    assert response.status_code == 302 and response.headers["Location"] == "/publish"
    assert browser.get("/api/me").get_json()["user"]["username"] == "admin"
    assert first.test_client().post("/auth/sso/accept", data={"ticket": ticket}).status_code == 400
    for_kit = protocol.make_ticket(SECRET, email="admin@localhost", audience="construction-kit", purpose="login", ttl=60)
    assert first.test_client().post("/auth/sso/accept", data={"ticket": for_kit}).status_code == 400


def test_construction_kit_link_makes_a_ticket_for_the_kit(pair):
    first, _ = pair
    page = admin(first).get("/auth/sso/peer?next=/projects").get_data(as_text=True)
    assert 'action="http://b.test/auth/sso/accept"' in page
    ticket = page.split('name="ticket" value="', 1)[1].split('"', 1)[0]
    assert protocol.read_ticket(SECRET, ticket, audience="construction-kit", purpose="login")["email"] == "admin@localhost"


def test_api_ticket_works_once_as_a_bearer_token(pair):
    first, _ = pair
    ticket = protocol.make_ticket(SECRET, email="admin@localhost", audience="cartridge-store", purpose="api", ttl=120)
    headers = {"Authorization": f"Bearer {ticket}"}
    assert first.test_client().get("/api/me", headers=headers).get_json()["user"]["username"] == "admin"
    assert first.test_client().get("/api/me", headers=headers).get_json()["user"]["authenticated"] is False
    login_ticket = protocol.make_ticket(SECRET, email="admin@localhost", audience="cartridge-store", purpose="login", ttl=60)
    response = first.test_client().get("/api/me", headers={"Authorization": f"Bearer {login_ticket}"})
    assert response.get_json()["user"]["authenticated"] is False


def test_old_user_tables_get_updated_at(tmp_path):
    import sqlite3

    db_path = tmp_path / "cartridge_store.sqlite"
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,"
                           " email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user',"
                           " external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),"
                           " last_login TEXT)")
    store = make_store(tmp_path)
    admin(store)
    assert "updated_at" in emails(store)["admin@localhost"]
