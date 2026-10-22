"""GDPR-oriented transparency, rights, and retention controls."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import secrets
from typing import Any

import click
from flask import Flask, Response, flash, jsonify, redirect, render_template, request, session, url_for

from . import sso
from .auth import current_principal, login_required, recently_authenticated, role_at_least
from .database import add_column_if_missing, get_db, init_schema_once
from .settings import get_setting
from .store import GameStore
from werkzeug.security import check_password_hash


PRIVACY_NOTICE_VERSION = "2026-10-21"
PRIVACY_SCHEMA = """
CREATE TABLE IF NOT EXISTS privacy_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type   TEXT NOT NULL,
    subject_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS privacy_events_created_idx ON privacy_events(created_at);
CREATE TABLE IF NOT EXISTS privacy_notice_deliveries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version    TEXT NOT NULL,
    channel    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, version, channel)
);
CREATE TABLE IF NOT EXISTS privacy_cleanup_status (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    last_success TEXT,
    last_failure TEXT,
    last_error   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS privacy_rights_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_ref   TEXT NOT NULL UNIQUE,
    request_type TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def init_privacy_db() -> None:
    db = get_db()
    db.executescript(PRIVACY_SCHEMA)
    add_column_if_missing(db, "users", "privacy_notice_version", "TEXT")
    add_column_if_missing(db, "users", "privacy_notified_at", "TEXT")
    add_column_if_missing(db, "privacy_events", "event_ref", "TEXT")
    db.execute("UPDATE privacy_events SET subject_hash = '' WHERE subject_hash != ''")
    _migrate_denormalized_identities(db)
    db.commit()


def mark_privacy_notice_delivered(user_id: int, channel: str = "web") -> None:
    get_db().execute(
        "UPDATE users SET privacy_notice_version = ?, privacy_notified_at = ? WHERE id = ?",
        (PRIVACY_NOTICE_VERSION, _utc_now(), user_id),
    )
    get_db().execute(
        "INSERT OR IGNORE INTO privacy_notice_deliveries(user_id, version, channel) VALUES (?, ?, ?)",
        (user_id, PRIVACY_NOTICE_VERSION, str(channel)[:40]),
    )
    get_db().commit()


def privacy_context() -> dict[str, Any]:
    try:
        records = json.loads(get_setting("privacy_processing_records", "[]"))
        if not isinstance(records, list):
            records = []
    except json.JSONDecodeError:
        records = []
    context = {
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
        "audit_retention_days": _days("privacy_audit_retention_days", 365),
        "representative": get_setting("privacy_representative", ""),
        "recipient_categories": get_setting("privacy_recipient_categories", ""),
        "transfer_details": get_setting("privacy_transfer_details", ""),
        "data_provision": get_setting("privacy_data_provision", ""),
        "processing_records": records,
    }
    context["ready"] = bool(
        context["controller_name"]
        and context["privacy_contact_email"]
        and context["supervisory_authority"]
        and records
        and all(
            isinstance(record, dict)
            and record.get("purpose")
            and record.get("data_categories")
            and record.get("legal_basis")
            and record.get("retention")
            for record in records
        )
    )
    return context


def export_user_data(user_id: int, store: GameStore) -> dict[str, Any]:
    db = get_db()
    user = db.execute(
        "SELECT id, username, email, public_handle, role, external_provider, created_at, updated_at, last_login, "
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
        "notice_deliveries": _rows_if_table(
            "SELECT version, channel, created_at FROM privacy_notice_deliveries WHERE user_id = ? ORDER BY created_at",
            (user_id,),
        ),
        "sso_queue": _rows_if_table(
            "SELECT created_at, attempts FROM sso_outbox WHERE email = ?", (str(user["email"]),)
        ),
        "catalog_activity": store.personal_catalog_records(
            {str(user["username"]), str(user["email"]), str(user["public_handle"])}
        ),
        "article_15_information": privacy_context(),
    }


def erase_user(user_id: int, store: GameStore, *, notify_sso: bool = True) -> bool:
    """Erase an account and linked records; anonymise shared records."""
    db = get_db()
    row = db.execute("SELECT username, email, public_handle, role FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return False
    if row["role"] == "admin":
        remaining = db.execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND id != ?", (user_id,)).fetchone()
        if int(remaining["count"]) == 0:
            raise ValueError("the last administrator account cannot be erased")
    username, email, public_handle = str(row["username"]), str(row["email"]), str(row["public_handle"])
    published_authorship = [
        item for item in store.personal_catalog_records({username, email, public_handle})
        if item["role"].startswith("published ")
    ]
    _execute_if_table("DELETE FROM runs WHERE user_id = ?", (user_id,))
    _execute_if_table("DELETE FROM download_events WHERE user_id = ?", (user_id,))
    _execute_if_table(
        "UPDATE scores SET submitted_by = 'deleted user', user_id = NULL "
        "WHERE user_id = ? OR (user_id IS NULL AND submitted_by = ?)", (user_id, username)
    )
    _execute_if_table(
        "UPDATE cartridge_submissions SET submitted_by = 'deleted user' WHERE submitted_by_user_id = ?", (user_id,)
    )
    _execute_if_table(
        "UPDATE cartridge_submissions SET reviewed_by = 'deleted user' WHERE reviewed_by_user_id = ?", (user_id,)
    )
    _execute_if_table("DELETE FROM sso_outbox WHERE email = ?", (email,))
    store.replace_publisher_identities({username, email, public_handle}, "deleted user")
    db.execute("DELETE FROM registration_tokens WHERE email = ?", (email,))
    db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    event_ref = secrets.token_urlsafe(18)
    db.execute(
        "INSERT INTO privacy_events(event_type, subject_hash, event_ref) VALUES ('erasure', '', ?)",
        (event_ref,),
    )
    db.execute(
        "INSERT INTO privacy_rights_requests(event_ref, request_type, status) VALUES (?, 'erasure', ?)",
        (event_ref, "authorship-review-required" if published_authorship else "completed"),
    )
    db.commit()
    if notify_sso:
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
    audit_days = _days("privacy_audit_retention_days", 365)
    db.execute("DELETE FROM privacy_events WHERE created_at < datetime('now', ?)", (f"-{audit_days} days",))
    db.execute("DELETE FROM privacy_rights_requests WHERE created_at < datetime('now', ?)", (f"-{audit_days} days",))
    db.execute(
        "DELETE FROM sso_outbox WHERE created_at < datetime('now', ?)",
        (f"-{_days('privacy_registration_retention_days', 7)} days",),
    )
    db.execute(
        "INSERT INTO privacy_cleanup_status(id, last_success, last_error) VALUES (1, ?, '') "
        "ON CONFLICT(id) DO UPDATE SET last_success = excluded.last_success, last_error = ''",
        (_utc_now(),),
    )
    db.commit()
    return counts


def register_privacy_routes(app: Flask, store: GameStore) -> None:
    app.extensions.setdefault("privacy_catalog_migrated", False)

    @app.before_request
    def before_privacy_request() -> None:
        init_schema_once("privacy", init_privacy_db)
        if not app.extensions["privacy_catalog_migrated"]:
            for row in get_db().execute("SELECT username, email, public_handle FROM users").fetchall():
                store.replace_publisher_identities(
                    {str(row["username"]), str(row["email"])},
                    str(row["public_handle"]),
                )
            app.extensions["privacy_catalog_migrated"] = True
        if session.get("privacy_notice_pending") and request.endpoint not in {
            "privacy_notice",
            "privacy_acknowledge",
            "privacy_acknowledge_post",
            "auth_logout",
            "static",
        }:
            return redirect(url_for("privacy_acknowledge", next=request.full_path))

    @app.after_request
    def privacy_security_headers(response: Response) -> Response:
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: https:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'",
        )
        if request.is_secure:
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
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

    @app.get("/auth/privacy-acknowledge")
    @login_required
    def privacy_acknowledge():
        return render_template(
            "privacy_acknowledge.html",
            privacy=privacy_context(),
            next=request.args.get("next", url_for("index")),
        )

    @app.post("/auth/privacy-acknowledge")
    @login_required
    def privacy_acknowledge_post():
        target = request.form.get("next", url_for("index"))
        if request.form.get("privacy_notice_version") != PRIVACY_NOTICE_VERSION:
            return render_template(
                "privacy_acknowledge.html",
                privacy=privacy_context(),
                next=target,
                error="Acknowledge the current notice to continue.",
            ), 400
        principal = current_principal()
        mark_privacy_notice_delivered(int(principal.id), str(principal.external_provider or "sso"))
        session.pop("privacy_notice_pending", None)
        if not target.startswith("/") or target.startswith("//"):
            target = url_for("index")
        return redirect(target)

    @app.get("/admin/privacy")
    def privacy_readiness():
        principal = current_principal()
        if not principal.authenticated or not role_at_least(principal.role, "admin"):
            return jsonify({"ok": False, "error": "administrator required"}), 403
        status = _rows_if_table("SELECT last_success, last_failure, last_error FROM privacy_cleanup_status WHERE id = 1", ())
        requests = _rows_if_table(
            "SELECT event_ref, request_type, status, created_at FROM privacy_rights_requests "
            "WHERE status != 'completed' ORDER BY created_at",
            (),
        )
        return render_template("admin_privacy.html", privacy=privacy_context(), cleanup=status[0] if status else None, rights_requests=requests)

    @app.get("/api/me/export")
    @login_required
    def account_export():
        if not recently_authenticated():
            return jsonify({"ok": False, "error": "recent authentication required"}), 403
        payload = export_user_data(int(current_principal().id), store)
        response = Response(json.dumps(payload, indent=2, sort_keys=True) + "\n", mimetype="application/json")
        response.headers["Content-Disposition"] = "attachment; filename=cartridge-store-personal-data.json"
        return response

    @app.post("/account/delete")
    @login_required
    def account_delete():
        principal = current_principal()
        if not recently_authenticated():
            return render_template("account_privacy.html", privacy=privacy_context(), error="Sign in again before erasing your account."), 403
        account = get_db().execute("SELECT password_hash FROM users WHERE id = ?", (principal.id,)).fetchone()
        if account and account["password_hash"]:
            if not check_password_hash(str(account["password_hash"]), request.form.get("password", "")):
                return render_template("account_privacy.html", privacy=privacy_context(), error="Current password is incorrect."), 403
        if request.form.get("confirmation", "") != "DELETE":
            return render_template("account_privacy.html", privacy=privacy_context(), error="Type DELETE to confirm."), 400
        try:
            erase_user(int(principal.id), store)
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
        if not recently_authenticated():
            return jsonify({"ok": False, "error": "recent authentication required"}), 403
        return jsonify({"ok": True, "deleted": apply_retention()})

    @app.cli.command("privacy-cleanup")
    @click.option("--dry-run", is_flag=True, help="Report expired records without deleting them.")
    def privacy_cleanup_command(dry_run: bool) -> None:
        """Apply configured personal-data retention limits."""
        _initialize_cli_schemas()
        if dry_run:
            click.echo(json.dumps(retention_due_counts(), sort_keys=True))
            return
        try:
            click.echo(json.dumps(apply_retention(), sort_keys=True))
        except Exception as exc:
            get_db().execute(
                "INSERT INTO privacy_cleanup_status(id, last_failure, last_error) VALUES (1, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET last_failure = excluded.last_failure, last_error = excluded.last_error",
                (_utc_now(), str(exc)[:500]),
            )
            get_db().commit()
            raise click.ClickException(str(exc)) from exc


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


def retention_due_counts() -> dict[str, int]:
    db = get_db()
    queries = {
        "download_events": ("SELECT COUNT(*) AS count FROM download_events WHERE downloaded_at < datetime('now', ?)", _days("privacy_download_retention_days", 90)),
        "runs": ("SELECT COUNT(*) AS count FROM runs WHERE created_at < strftime('%s', 'now', ?)", _days("privacy_metrics_retention_days", 365)),
        "registration_tokens": ("SELECT COUNT(*) AS count FROM registration_tokens WHERE created_at < datetime('now', ?)", _days("privacy_registration_retention_days", 7)),
    }
    return {
        name: int(db.execute(sql, (f"-{days} days",)).fetchone()["count"])
        for name, (sql, days) in queries.items()
    }


def _migrate_denormalized_identities(db: Any) -> None:
    statements = (
        "UPDATE scores SET submitted_by = (SELECT public_handle FROM users WHERE users.id = scores.user_id) WHERE user_id IS NOT NULL",
        "UPDATE runs SET submitted_by = (SELECT public_handle FROM users WHERE users.id = runs.user_id) WHERE user_id IS NOT NULL",
        "UPDATE cartridge_submissions SET submitted_by = (SELECT public_handle FROM users WHERE users.id = cartridge_submissions.submitted_by_user_id) WHERE submitted_by_user_id IS NOT NULL",
        "UPDATE cartridge_submissions SET reviewed_by = (SELECT public_handle FROM users WHERE users.id = cartridge_submissions.reviewed_by_user_id) WHERE reviewed_by_user_id IS NOT NULL",
        "UPDATE scores SET submitted_by = 'legacy user' WHERE user_id IS NULL AND instr(submitted_by, '@') > 0",
        "UPDATE runs SET submitted_by = 'legacy user' WHERE user_id IS NULL AND instr(submitted_by, '@') > 0",
        "UPDATE cartridge_submissions SET submitted_by = 'legacy user' WHERE submitted_by_user_id IS NULL AND instr(submitted_by, '@') > 0",
        "UPDATE cartridge_submissions SET reviewed_by = 'legacy user' WHERE reviewed_by_user_id IS NULL AND instr(reviewed_by, '@') > 0",
    )
    for statement in statements:
        _execute_if_table(statement, ())


def _initialize_cli_schemas() -> None:
    from .auth import init_auth_db
    from .metrics import init_metrics_db
    from .review import init_review_db
    from .scores import init_scores_db
    from .settings import init_settings_db
    from .sso import init_sso_db
    from .stats import init_stats_db

    for initializer in (
        init_auth_db,
        init_settings_db,
        init_scores_db,
        init_metrics_db,
        init_stats_db,
        init_review_db,
        init_sso_db,
        init_privacy_db,
    ):
        initializer()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
