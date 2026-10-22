"""Single sign-on and user sync between this store and one PRG32-Construction-Kit.

Turn it on by giving *both* services the same two settings:

    PRG32_SSO_SECRET    a long random secret (at least 32 characters)
    PRG32_SSO_PEER_URL  the other service's address, e.g. http://kit.school:5090

Then:

- a user created, changed or deleted here is created, changed or deleted on
  the Construction Kit too, and the other way round;
- "Construction Kit" in the menu signs the user in there without a second password;
- the kit publishes cartridges here as the signed-in student, using a one-time
  API ticket instead of a stored token.

If the other service is offline, the change waits in a small outbox and is
sent with the next change or the next "Sync now". The protocol itself is in
``sso_protocol.py``, which is the same file in both repositories.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from flask import Flask, current_app, flash, jsonify, redirect, render_template, request, session, url_for

from . import sso_protocol as protocol
from .database import add_column_if_missing, get_db, init_schema_once

AUDIENCE_HERE = protocol.AUDIENCE_STORE
AUDIENCE_PEER = protocol.AUDIENCE_KIT

SSO_SCHEMA = """
CREATE TABLE IF NOT EXISTS sso_nonces (
    nonce      TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sso_nonces_expiry_idx ON sso_nonces(expires_at);

CREATE TABLE IF NOT EXISTS sso_outbox (
    email      TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    attempts   INTEGER NOT NULL DEFAULT 0
);
"""


def init_sso_db() -> None:
    db = get_db()
    db.executescript(SSO_SCHEMA)
    # Older stores have no users.updated_at; user sync needs it to keep the newest change.
    add_column_if_missing(db, "users", "updated_at", "TEXT")
    db.commit()


# --- settings -----------------------------------------------------------------

def enabled() -> bool:
    return protocol.secret_is_usable(current_app.config.get("SSO_SECRET")) and bool(peer_url())


def peer_url() -> str:
    return str(current_app.config.get("SSO_PEER_URL") or "").strip().rstrip("/")


def _secret() -> str:
    return str(current_app.config["SSO_SECRET"])


def status() -> dict[str, Any]:
    if not enabled():
        return {"enabled": False, "abi": protocol.SSO_ABI}
    init_schema_once("sso", init_sso_db)
    row = get_db().execute("SELECT COUNT(*) AS count FROM sso_outbox").fetchone()
    return {"enabled": True, "abi": protocol.SSO_ABI, "peer_url": peer_url(), "pending": int(row["count"])}


# --- talking to the other service --------------------------------------------

Transport = Callable[[str, str, dict[str, str], bytes], tuple[int, bytes]]


def _urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body if method != "GET" else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=float(current_app.config.get("SSO_TIMEOUT", 5))) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _call_peer(method: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else b""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    headers.update(protocol.sign_request(_secret(), method, protocol.USERS_PATH, body))
    transport: Transport = current_app.config.get("SSO_TRANSPORT") or _urllib_transport
    status_code, raw = transport(method, peer_url() + protocol.USERS_PATH, headers, body)
    if status_code != 200:
        raise ConnectionError(f"Construction Kit answered {status_code}: {raw[:200]!r}")
    return json.loads(raw.decode("utf-8"))


# --- records ------------------------------------------------------------------

def user_record(row: Any) -> dict[str, Any]:
    from .auth import groups_for_user

    return {
        "email": str(row["email"]),
        "username": str(row["username"]),
        "password_hash": row["password_hash"],
        "role": str(row["role"]),
        "groups": list(groups_for_user(int(row["id"]))),
        "updated_at": row["updated_at"] or row["created_at"],
        "deleted": False,
    }


def _queue(records: list[dict[str, Any]]) -> None:
    db = get_db()
    for record in records:
        db.execute(
            """
            INSERT INTO sso_outbox(email, payload, attempts) VALUES (?, ?, 1)
            ON CONFLICT(email) DO UPDATE SET payload = excluded.payload, attempts = sso_outbox.attempts + 1
            """,
            (record["email"], json.dumps(record)),
        )
    db.commit()


def push(records: list[dict[str, Any]]) -> bool:
    """Send records (plus anything still waiting in the outbox) to the other service."""
    if not enabled():
        return False
    init_schema_once("sso", init_sso_db)
    db = get_db()
    waiting = {str(row["email"]): json.loads(row["payload"]) for row in db.execute("SELECT * FROM sso_outbox")}
    for record in records:
        waiting.pop(record["email"], None)
    batch = list(waiting.values()) + records
    if not batch:
        return True
    try:
        _call_peer("POST", {"abi": protocol.SSO_ABI, "users": batch})
    except Exception as exc:  # the kit may be offline; try again later
        current_app.logger.warning("User sync with %s failed, will retry: %s", peer_url(), exc)
        _queue(batch)
        return False
    db.executemany("DELETE FROM sso_outbox WHERE email = ?", [(record["email"],) for record in batch])
    db.commit()
    return True


def user_changed(user_id: int, previous_email: str | None = None) -> None:
    """Call after any change to a user: marks the change time and tells the kit."""
    init_schema_once("sso", init_sso_db)
    db = get_db()
    db.execute("UPDATE users SET updated_at = ? WHERE id = ?", (protocol.timestamp_now(), user_id))
    db.commit()
    if not enabled():
        return
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return
    record = user_record(row)
    if previous_email and previous_email != record["email"]:
        record["previous_email"] = previous_email
    push([record])


def user_deleted(email: str) -> None:
    if enabled() and email:
        push([{"email": email, "deleted": True, "updated_at": protocol.timestamp_now()}])


def _admin_count(excluding: int) -> int:
    row = get_db().execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND id != ?", (excluding,)).fetchone()
    return int(row["count"])


def apply_record(data: Any) -> str:
    """Store one user record that came from the other service. The newest change wins.

    This never sends anything back, so two services cannot bounce a change forever.
    """
    from .auth import _unique_username, set_user_groups, unique_public_handle

    init_schema_once("sso", init_sso_db)
    record = protocol.clean_record(data)
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE email = ?", (record["email"],)).fetchone()
    if row is None and record["previous_email"]:
        row = db.execute("SELECT * FROM users WHERE email = ?", (record["previous_email"],)).fetchone()
    local_stamp = (row["updated_at"] or row["created_at"]) if row is not None else None
    if record["deleted"]:
        if row is None:
            return "unknown"
        if not protocol.is_newer(record["updated_at"], local_stamp):
            return "stale"
        if row["role"] == "admin" and _admin_count(int(row["id"])) == 0:
            return "kept-last-admin"
        from .privacy import erase_user
        from .store import GameStore

        erase_user(
            int(row["id"]),
            GameStore(current_app.config["DATA_DIR"]),
            notify_sso=False,
        )
        return "deleted"
    if row is not None and not protocol.is_newer(record["updated_at"], local_stamp):
        return "stale"
    stamp = record["updated_at"] or protocol.timestamp_now()
    if row is None:
        cursor = db.execute(
            "INSERT INTO users(username, email, password_hash, role, updated_at, public_handle) VALUES (?, ?, ?, ?, ?, ?)",
            (_unique_username(record["username"], record["email"]), record["email"], record["password_hash"],
             record["role"], stamp, unique_public_handle()),
        )
        user_id = int(cursor.lastrowid)
        result = "created"
    else:
        user_id = int(row["id"])
        if row["role"] == "admin" and record["role"] != "admin" and _admin_count(user_id) == 0:
            return "kept-last-admin"
        username = str(row["username"])
        if record["username"] != username:
            taken = db.execute("SELECT 1 FROM users WHERE username = ? AND id != ?", (record["username"], user_id)).fetchone()
            username = record["username"] if taken is None else username
        db.execute(
            "UPDATE users SET username = ?, email = ?, password_hash = ?, role = ?, updated_at = ? WHERE id = ?",
            (username, record["email"], record["password_hash"], record["role"], stamp, user_id),
        )
        result = "updated"
    db.commit()
    set_user_groups(user_id, record["groups"])
    return result


def full_sync() -> dict[str, Any]:
    """Make both services agree: send waiting changes, take theirs, then send ours."""
    if not enabled():
        raise ValueError("Single sign-on is not configured (PRG32_SSO_SECRET and PRG32_SSO_PEER_URL)")
    if not push([]):
        raise ConnectionError(f"Could not reach {peer_url()}")
    remote = _call_peer("GET").get("users", [])
    results: dict[str, int] = {}
    for record in remote:
        try:
            outcome = apply_record(record)
        except ValueError:
            outcome = "invalid"
        results[outcome] = results.get(outcome, 0) + 1
    local = [user_record(row) for row in get_db().execute("SELECT * FROM users")]
    sent = push(local)
    return {"ok": sent, "received": len(remote), "applied": results, "sent": len(local)}


# --- tickets ------------------------------------------------------------------

def make_ticket(email: str, purpose: str) -> str:
    ttl = protocol.LOGIN_TICKET_SECONDS if purpose == "login" else protocol.API_TICKET_SECONDS
    return protocol.make_ticket(_secret(), email=email, audience=AUDIENCE_PEER, purpose=purpose, ttl=ttl)


def use_ticket(ticket: str, purpose: str) -> str | None:
    """Return the email inside a valid ticket meant for us, and mark it used."""
    if not enabled():
        return None
    claims = protocol.read_ticket(_secret(), ticket, audience=AUDIENCE_HERE, purpose=purpose)
    if claims is None:
        return None
    init_schema_once("sso", init_sso_db)
    db = get_db()
    db.execute("DELETE FROM sso_nonces WHERE expires_at < ?", (int(time.time()),))
    cursor = db.execute("INSERT OR IGNORE INTO sso_nonces(nonce, expires_at) VALUES (?, ?)",
                        (claims["nonce"], int(claims["exp"])))
    db.commit()
    if cursor.rowcount != 1:
        return None  # this ticket was already used
    return str(claims["email"])


# --- routes -------------------------------------------------------------------

def register_sso_routes(app: Flask) -> None:
    from .auth import admin_required, current_principal, load_user, login_required, utc_now

    @app.route(protocol.USERS_PATH, methods=["GET", "POST"])
    def sso_peer_users():
        """Only the synced Construction Kit can call this: every request is signed."""
        if not enabled() or not protocol.verify_request(_secret(), request.method, protocol.USERS_PATH,
                                                        request.get_data(cache=True), request.headers):
            return jsonify({"ok": False, "error": "bad or missing SSO signature"}), 403
        if request.method == "GET":
            users = [user_record(row) for row in get_db().execute("SELECT * FROM users")]
            return jsonify({"ok": True, "abi": protocol.SSO_ABI, "users": users})
        data = request.get_json(silent=True) or {}
        records = data.get("users")
        if not isinstance(records, list):
            return jsonify({"ok": False, "error": "users must be a list"}), 400
        results = []
        for record in records:
            try:
                results.append(apply_record(record))
            except ValueError as exc:
                results.append(f"invalid: {exc}")
        return jsonify({"ok": True, "abi": protocol.SSO_ABI, "results": results})

    @app.post("/admin/sso/sync")
    @admin_required
    def sso_sync_now():
        try:
            result = full_sync()
        except Exception as exc:
            if request.is_json:
                return jsonify({"ok": False, "error": str(exc)}), 502
            flash(f"Sync failed: {exc}")
            return redirect(url_for("admin_users"))
        if request.is_json:
            return jsonify(result)
        flash(f"Sync done: received {result['received']} users, sent {result['sent']}.")
        return redirect(url_for("admin_users"))

    @app.get("/auth/sso/peer")
    @login_required
    def sso_go_to_peer():
        """Sign the current user in on the Construction Kit and open it there."""
        if not enabled():
            return render_template("error.html", error="Single sign-on with a Construction Kit is not configured."), 404
        principal = current_principal()
        if not principal.email:
            return render_template("error.html", error="This account has no email, so it cannot be shared."), 400
        target = request.args.get("next") or "/"
        if not target.startswith("/") or target.startswith("//"):
            target = "/"
        return render_template("sso_redirect.html", action=peer_url() + protocol.ACCEPT_PATH,
                               ticket=make_ticket(principal.email, "login"), next=target)

    @app.post(protocol.ACCEPT_PATH)
    def sso_accept_login():
        """The Construction Kit sent a signed-in user here with a one-time ticket."""
        email = use_ticket(request.form.get("ticket", ""), "login")
        if email is None:
            return render_template("error.html", error="This sign-in link is invalid, expired, or already used."), 400
        row = get_db().execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if row is None:
            return render_template("error.html", error="Your account has not reached the Cartridge Store yet. "
                                                       "Ask your teacher to press Sync now."), 404
        get_db().execute("UPDATE users SET last_login = ? WHERE id = ?", (utc_now(), int(row["id"])))
        get_db().commit()
        principal = load_user(int(row["id"]))
        session.clear()
        session["user_id"] = principal.id
        session["role"] = principal.role
        session["authenticated_at"] = time.time()
        if not current_app.config.get("TESTING"):
            session["privacy_notice_pending"] = True
        target = request.form.get("next") or "/"
        if not target.startswith("/") or target.startswith("//"):
            target = "/"
        if current_app.config.get("TESTING"):
            return redirect(target)
        return redirect(url_for("privacy_acknowledge", next=target))

    @app.context_processor
    def inject_sso() -> dict[str, Any]:
        return {"sso_enabled": enabled()}
