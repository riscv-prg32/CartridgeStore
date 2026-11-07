"""Administrator event log.

The Cartridge Store keeps two kinds of log for administrators:

* the **event log**, a SQLite table of explicit events (sign-ins, account and
  catalog changes, submission reviews, backups, privacy requests) plus
  server errors and warnings raised while a request is handled;
* the **process log**, an in-memory ring buffer with the most recent Python
  log records of this server process (for example mDNS or SSO warnings raised
  outside a request).  It is lost on restart.

Both are minimised for GDPR: messages never carry email addresses or secrets,
an event's actor is the public handle (anonymised when the account is erased),
and stored events are deleted after ``privacy_log_retention_days``.
"""

from __future__ import annotations

from collections import deque
import csv
from datetime import datetime, timezone
from io import StringIO
import logging
import re
from threading import Lock
from typing import Any

from flask import Flask, Response, g, has_request_context, jsonify, render_template, request

from .auth import admin_required, current_principal
from .database import get_db, init_schema_once


LOG_SCHEMA = """
CREATE TABLE IF NOT EXISTS app_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    level         TEXT NOT NULL,
    category      TEXT NOT NULL,
    event         TEXT NOT NULL,
    message       TEXT NOT NULL DEFAULT '',
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor         TEXT NOT NULL DEFAULT '',
    method        TEXT NOT NULL DEFAULT '',
    path          TEXT NOT NULL DEFAULT '',
    status        INTEGER
);

CREATE INDEX IF NOT EXISTS app_events_created_idx ON app_events(created_at);
CREATE INDEX IF NOT EXISTS app_events_level_idx ON app_events(level, created_at);
CREATE INDEX IF NOT EXISTS app_events_category_idx ON app_events(category, created_at);
"""

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
LEVEL_RANK = {name: rank for rank, name in enumerate(LEVELS)}
CATEGORIES = ("auth", "admin", "catalog", "review", "privacy", "system")
PROCESS_LOG_SIZE = 500
PAGE_SIZE = 50

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SECRET_RE = re.compile(r"(?i)\b(token|password|secret|key)=[^\s&]+")


def redact(text: str) -> str:
    """Remove email addresses and ``token=...`` style secrets from a message."""
    text = EMAIL_RE.sub("[email]", str(text))
    return SECRET_RE.sub(lambda match: f"{match.group(1)}=[redacted]", text)


def init_logs_db() -> None:
    db = get_db()
    db.executescript(LOG_SCHEMA)
    db.commit()


def log_event(
    category: str,
    event: str,
    message: str = "",
    *,
    level: str = "INFO",
    status: int | None = None,
) -> None:
    """Record one administrator-visible event for the current request.

    The event is written when the request finishes, after the route has
    committed its own work, so logging never commits a half-done change.
    """
    level = level.upper() if level.upper() in LEVEL_RANK else "INFO"
    principal = current_principal() if has_request_context() else None
    entry = {
        "level": level,
        "category": category if category in CATEGORIES else "system",
        "event": str(event)[:80],
        "message": redact(message)[:1000],
        "actor_user_id": principal.id if principal and principal.authenticated else None,
        "actor": principal.name if principal and principal.authenticated else "",
        "method": request.method if has_request_context() else "",
        "path": request.path[:300] if has_request_context() else "",
        "status": status,
    }
    if has_request_context():
        g.setdefault("prg32_pending_events", []).append(entry)
    else:
        _write_events([entry])


def _write_events(entries: list[dict[str, Any]]) -> None:
    if not entries:
        return
    init_schema_once("logs", init_logs_db)
    db = get_db()
    db.executemany(
        """
        INSERT INTO app_events(level, category, event, message, actor_user_id, actor, method, path, status)
        VALUES (:level, :category, :event, :message, :actor_user_id, :actor, :method, :path, :status)
        """,
        entries,
    )
    db.commit()


class ProcessLogBuffer(logging.Handler):
    """Keep the latest log records of this process for the admin log page.

    Records raised while a request is handled at WARNING or above are also
    queued as stored ``system`` events.  A record can opt out of storage and
    of the buffer with ``extra={"prg32_private": True}``.
    """

    def __init__(self, size: int = PROCESS_LOG_SIZE) -> None:
        super().__init__(level=logging.INFO)
        self.records: deque[dict[str, Any]] = deque(maxlen=size)
        self.buffer_lock = Lock()

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(record, "prg32_private", False):
            return
        try:
            message = redact(record.getMessage())[:1000]
        except Exception:  # a broken format string must not break the request
            message = redact(str(record.msg))[:1000]
        item = {
            "created_at": datetime.fromtimestamp(record.created, timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "message": message,
        }
        with self.buffer_lock:
            self.records.append(item)
        if record.levelno >= logging.WARNING and has_request_context():
            g.setdefault("prg32_pending_events", []).append(
                {
                    "level": record.levelname if record.levelname in LEVEL_RANK else "WARNING",
                    "category": "system",
                    "event": "log." + record.name[:60],
                    "message": message,
                    "actor_user_id": None,
                    "actor": "",
                    "method": request.method,
                    "path": request.path[:300],
                    "status": None,
                }
            )

    def recent(self, minimum_level: str = "INFO") -> list[dict[str, Any]]:
        rank = LEVEL_RANK.get(minimum_level, 1)
        with self.buffer_lock:
            items = list(self.records)
        return [item for item in reversed(items) if LEVEL_RANK.get(item["level"], 1) >= rank]


def _query_filters() -> tuple[str, list[Any], dict[str, str]]:
    level = request.args.get("level", "INFO").upper()
    if level not in LEVEL_RANK:
        level = "INFO"
    category = request.args.get("category", "")
    if category not in CATEGORIES:
        category = ""
    text = request.args.get("q", "").strip()[:100]
    since = request.args.get("since", "").strip()
    until = request.args.get("until", "").strip()
    date_re = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    since = since if date_re.fullmatch(since) else ""
    until = until if date_re.fullmatch(until) else ""

    allowed = [name for name in LEVELS if LEVEL_RANK[name] >= LEVEL_RANK[level]]
    where = [f"level IN ({', '.join('?' for _ in allowed)})"]
    params: list[Any] = list(allowed)
    if category:
        where.append("category = ?")
        params.append(category)
    if text:
        where.append("(event LIKE ? OR message LIKE ? OR actor LIKE ? OR path LIKE ?)")
        params.extend([f"%{text}%"] * 4)
    if since:
        where.append("substr(created_at, 1, 10) >= ?")
        params.append(since)
    if until:
        where.append("substr(created_at, 1, 10) <= ?")
        params.append(until)
    query = {"level": level, "category": category, "q": text, "since": since, "until": until}
    return " AND ".join(where), params, query


def query_events(limit: int = PAGE_SIZE, offset: int = 0) -> tuple[list[dict[str, Any]], int, dict[str, str]]:
    where, params, query = _query_filters()
    db = get_db()
    total = int(db.execute(f"SELECT COUNT(*) AS count FROM app_events WHERE {where}", params).fetchone()["count"])
    rows = db.execute(
        f"""
        SELECT id, created_at, level, category, event, message, actor, method, path, status
        FROM app_events
        WHERE {where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
        """,
        (*params, limit, offset),
    ).fetchall()
    return [dict(row) for row in rows], total, query


def level_counts(days: int = 7) -> dict[str, int]:
    rows = get_db().execute(
        """
        SELECT level, COUNT(*) AS count FROM app_events
        WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
        GROUP BY level
        """,
        (f"-{int(days)} days",),
    ).fetchall()
    counts = {name: 0 for name in LEVELS}
    counts.update({str(row["level"]): int(row["count"]) for row in rows})
    return counts


_PROCESS_LOG: ProcessLogBuffer | None = None


def process_log() -> ProcessLogBuffer:
    """The one process-wide buffer, attached to the ``cartridge_store`` logger.

    Flask's ``app.logger`` (``cartridge_store.app``) and the mDNS, SSO and
    sign-in adapter loggers are its children, so one handler sees them all.
    """
    global _PROCESS_LOG
    if _PROCESS_LOG is None:
        _PROCESS_LOG = ProcessLogBuffer()
        package_logger = logging.getLogger("cartridge_store")
        package_logger.addHandler(_PROCESS_LOG)
        if package_logger.level == logging.NOTSET or package_logger.level > logging.INFO:
            package_logger.setLevel(logging.INFO)
    return _PROCESS_LOG


def register_log_routes(app: Flask) -> None:
    buffer = process_log()
    app.extensions["prg32_process_log"] = buffer

    @app.before_request
    def before_logs_request() -> None:
        init_schema_once("logs", init_logs_db)

    @app.after_request
    def write_request_events(response: Response) -> Response:
        if response.status_code >= 500:
            log_event(
                "system",
                "http.server_error",
                f"{request.method} {request.path} answered {response.status_code}",
                level="ERROR",
                status=response.status_code,
            )
        pending = g.pop("prg32_pending_events", [])
        if pending:
            try:
                get_db().rollback()  # never commit work a failed route left open
                _write_events(pending)
            except Exception as exc:  # logging must not turn a response into an error
                app.logger.debug("could not store events: %s", exc)
        return response

    @app.get("/admin/logs")
    @admin_required
    def admin_logs():
        page = max(request.args.get("page", default=1, type=int) or 1, 1)
        events, total, query = query_events(PAGE_SIZE, (page - 1) * PAGE_SIZE)
        pages = max((total + PAGE_SIZE - 1) // PAGE_SIZE, 1)
        return render_template(
            "admin_logs.html",
            events=events,
            total=total,
            page=min(page, pages),
            pages=pages,
            query=query,
            levels=LEVELS,
            categories=CATEGORIES,
            process_log=buffer.recent(query["level"])[:100],
            counts=level_counts(),
        )

    @app.get("/admin/logs.csv")
    @admin_required
    def admin_logs_csv():
        events, _, _ = query_events(limit=10000)
        output = StringIO()
        writer = csv.writer(output)
        columns = ["created_at", "level", "category", "event", "message", "actor", "method", "path", "status"]
        writer.writerow(columns)
        for event in events:
            writer.writerow([event[column] for column in columns])
        response = Response(output.getvalue(), mimetype="text/csv")
        response.headers["Content-Disposition"] = "attachment; filename=cartridge-store-events.csv"
        response.headers["Cache-Control"] = "no-store, private"
        return response

    @app.get("/api/admin/logs")
    @admin_required
    def api_admin_logs():
        limit = min(max(request.args.get("limit", default=PAGE_SIZE, type=int) or PAGE_SIZE, 1), 500)
        offset = max(request.args.get("offset", default=0, type=int) or 0, 0)
        events, total, query = query_events(limit, offset)
        return jsonify(
            {
                "ok": True,
                "total": total,
                "filters": query,
                "events": events,
                "process_log": buffer.recent(query["level"]),
            }
        )


def erase_actor(user_id: int) -> None:
    """Anonymise the events an erased account performed."""
    try:
        get_db().execute(
            "UPDATE app_events SET actor = 'deleted user', actor_user_id = NULL WHERE actor_user_id = ?",
            (user_id,),
        )
    except Exception as exc:
        if "no such table" not in str(exc):
            raise


def events_for_actor(user_id: int) -> list[dict[str, Any]]:
    try:
        rows = get_db().execute(
            "SELECT created_at, level, category, event, message, path FROM app_events "
            "WHERE actor_user_id = ? ORDER BY created_at",
            (user_id,),
        ).fetchall()
    except Exception as exc:
        if "no such table" in str(exc):
            return []
        raise
    return [dict(row) for row in rows]
