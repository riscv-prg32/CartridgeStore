"""GDPR-oriented transparency, rights, and retention controls."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import time
from typing import Any

from flask import Flask, Response, flash, jsonify, redirect, render_template, request, session, url_for

from . import sso
from .auth import current_principal, login_required, role_at_least
from .database import add_column_if_missing, get_db, init_schema_once
from .settings import get_setting


PRIVACY_NOTICE_VERSION = "2026-10-21"
PRIVACY_SCHEMA = """
CREATE TABLE IF NOT EXISTS privacy_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type   TEXT NOT NULL,
    subject_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS privacy_events_created_idx ON privacy_events(created_at);
"""


def init_privacy_db() -> None:
    db = get_db()
    db.executescript(PRIVACY_SCHEMA)
    add_column_if_missing(db, "users", "privacy_notice_version", "TEXT")
    add_column_if_missing(db, "users", "privacy_notified_at", "TEXT")
    db.commit()


def mark_privacy_notice_delivered(user_id: int) -> None:
    get_db().execute(
        "UPDATE users SET privacy_notice_version = ?, privacy_notified_at = ? WHERE id = ?",
        (PRIVACY_NOTICE_VERSION, _utc_now(), user_id),
    )
    get_db().commit()


def privacy_context() -> dict[str, Any]:
    return {
        "notice_version": PRIVACY_NOTICE_VERSION,
        "controller_name": get_setting("privacy_controller_name", "") or get_setting("store_institution", ""),
        "controller_address": get_setting("privacy_controller_address", ""),
        "privacy_contact_email": get_setting("privacy_contact_email", "") or get_setting("store_contact_email", ""),
        "dpo_email": get_setting("privacy_dpo_email", ""),
        "supervisory_authority": get_setting("privacy_supervisory_authority", ""),
        "supervisory_authority_url": get_setting("privacy_supervisory_authority_url", ""),
        "download_retention_days": _days("privacy_download_retention_days", 90),
        "metrics_retention_days": _days("privacy_metrics_retention_days", 365),
        "registration_retention_days": _days("privacy_registration_retention_days", 7),
    }


def export_user_data(user_id: int) -> dict[str, Any]:
    db = get_db()
    user = db.execute(
        "SELECT id, username, email, role, external_provider, created_at, updated_at, last_login, "
        "privacy_notice_version, privacy_notified_at FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if user is None:
        raise LookupError("user not found")
    username = str(user["username"])
    groups = [dict(row) for row in db.execute(
        "SELECT groups.name FROM groups JOIN user_groups ON groups.id = user_groups.group_id "
        "WHERE user_groups.user_id = ? ORDER BY groups.name", (user_id,)
    ).fetchall()]
    tokens = [dict(row) for row in db.execute(
        "SELECT id, label, created_at, last_used FROM api_tokens WHERE user_id = ? ORDER BY id", (user_id,)
    ).fetchall()]
    runs = _rows_if_table("SELECT * FROM runs WHERE user_id = ? ORDER BY created_at", (user_id,))
    samples: list[dict[str, Any]] = []
    for run in runs:
        samples.extend(_rows_if_table("SELECT * FROM samples WHERE run_id = ? ORDER BY frame", (run["run_id"],)))
    return {
        "format": "prg32-cartridge-store-data-export-1.0",
        "generated_at": _utc_now(),
        "privacy_notice_version": PRIVACY_NOTICE_VERSION,
        "account": dict(user),
        "groups": groups,
        "api_tokens": tokens,
        "runs": runs,
        "samples": samples,
        "scores": _rows_if_table(
            "SELECT game, player, score, created_at, submitted_by FROM scores "
            "WHERE user_id = ? OR (user_id IS NULL AND submitted_by = ?) ORDER BY created_at",
            (user_id, username),
        ),
        "submissions": _rows_if_table(
            "SELECT id, game_id, version, status, submitted_by, created_at, reviewed_at "
            "FROM cartridge_submissions WHERE submitted_by_user_id = ? OR reviewed_by_user_id = ? ORDER BY id",
            (user_id, user_id),
        ),
        "download_events": _rows_if_table(
            "SELECT game_id, version, architecture, downloaded_at FROM download_events "
            "WHERE user_id = ? ORDER BY downloaded_at", (user_id,)
        ),
    }


def erase_user(user_id: int) -> bool:
    """Erase an account and linked records; anonymise shared records."""
    db = get_db()
    row = db.execute("SELECT username, email, role FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return False
    if row["role"] == "admin":
        remaining = db.execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND id != ?", (user_id,)).fetchone()
        if int(remaining["count"]) == 0:
            raise ValueError("the last administrator account cannot be erased")
    username, email = str(row["username"]), str(row["email"])
    _execute_if_table("DELETE FROM runs WHERE user_id = ?", (user_id,))
    _execute_if_table("DELETE FROM download_events WHERE user_id = ?", (user_id,))
    _execute_if_table(
        "UPDATE scores SET submitted_by = 'deleted user', user_id = NULL "
        "WHERE user_id = ? OR (user_id IS NULL AND submitted_by = ?)", (user_id, username)
    )
    _execute_if_table(
        "UPDATE cartridge_submissions SET submitted_by = 'deleted user' WHERE submitted_by_user_id = ?", (user_id,)
    )
    db.execute("DELETE FROM registration_tokens WHERE email = ?", (email,))
    db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    db.execute("INSERT INTO privacy_events(event_type, subject_hash) VALUES ('erasure', ?)", (_subject_hash(email),))
    db.commit()
    sso.user_deleted(email)
    return True


def apply_retention() -> dict[str, int]:
    db = get_db()
    counts: dict[str, int] = {}
    cursor = db.execute(
        "DELETE FROM download_events WHERE downloaded_at < datetime('now', ?)",
        (f"-{_days('privacy_download_retention_days', 90)} days",),
    )
    counts["download_events"] = max(cursor.rowcount, 0)
    cursor = db.execute(
        "DELETE FROM runs WHERE created_at < strftime('%s', 'now', ?)",
        (f"-{_days('privacy_metrics_retention_days', 365)} days",),
    )
    counts["runs"] = max(cursor.rowcount, 0)
    cursor = db.execute(
        "DELETE FROM registration_tokens WHERE created_at < datetime('now', ?)",
        (f"-{_days('privacy_registration_retention_days', 7)} days",),
    )
    counts["registration_tokens"] = max(cursor.rowcount, 0)
    db.execute("DELETE FROM privacy_events WHERE created_at < datetime('now', '-6 years')")
    db.commit()
    return counts


def register_privacy_routes(app: Flask) -> None:
    app.extensions.setdefault("privacy_last_cleanup", 0.0)

    @app.before_request
    def before_privacy_request() -> None:
        init_schema_once("privacy", init_privacy_db)
        now = time.monotonic()
        if now - float(app.extensions["privacy_last_cleanup"]) >= 86400:
            apply_retention()
            app.extensions["privacy_last_cleanup"] = now

    @app.after_request
    def privacy_security_headers(response: Response) -> Response:
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if request.path.startswith(("/account/", "/api/me", "/auth/tokens")):
            response.headers["Cache-Control"] = "no-store, private"
        return response

    @app.get("/privacy")
    def privacy_notice():
        return render_template("privacy.html", privacy=privacy_context())

    @app.get("/account/privacy")
    @login_required
    def account_privacy():
        return render_template("account_privacy.html", privacy=privacy_context())

    @app.get("/api/me/export")
    @login_required
    def account_export():
        payload = export_user_data(int(current_principal().id))
        response = Response(json.dumps(payload, indent=2, sort_keys=True) + "\n", mimetype="application/json")
        response.headers["Content-Disposition"] = "attachment; filename=cartridge-store-personal-data.json"
        return response

    @app.post("/account/delete")
    @login_required
    def account_delete():
        principal = current_principal()
        if request.form.get("confirmation", "") != "DELETE":
            return render_template("account_privacy.html", privacy=privacy_context(), error="Type DELETE to confirm."), 400
        try:
            erase_user(int(principal.id))
        except ValueError as exc:
            return render_template("account_privacy.html", privacy=privacy_context(), error=str(exc)), 400
        session.clear()
        flash("Your account and linked personal data were erased.")
        return redirect(url_for("index"))

    @app.post("/admin/privacy/cleanup")
    def privacy_cleanup():
        principal = current_principal()
        if not principal.authenticated or not role_at_least(principal.role, "admin"):
            return jsonify({"ok": False, "error": "administrator required"}), 403
        return jsonify({"ok": True, "deleted": apply_retention()})


def _rows_if_table(sql: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    try:
        return [dict(row) for row in get_db().execute(sql, params).fetchall()]
    except Exception as exc:
        if "no such table" in str(exc) or "no such column" in str(exc):
            return []
        raise


def _execute_if_table(sql: str, params: tuple[Any, ...]) -> None:
    try:
        get_db().execute(sql, params)
    except Exception as exc:
        if "no such table" not in str(exc) and "no such column" not in str(exc):
            raise


def _days(key: str, default: int) -> int:
    try:
        return max(1, min(int(get_setting(key, str(default))), 3650))
    except (TypeError, ValueError):
        return default


def _subject_hash(value: str) -> str:
    return hashlib.sha256(value.strip().lower().encode("utf-8")).hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
