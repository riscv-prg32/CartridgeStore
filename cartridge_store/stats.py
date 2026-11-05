"""Download tracking and public statistics routes."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from pathlib import Path
import re
import time
from typing import Any

from flask import Flask, current_app, jsonify, render_template, request

from . import charts
from .auth import admin_required, current_principal
from .database import get_db, init_schema_once
from .settings import get_setting
from .store import GameStore, StoreError


STATS_SCHEMA = """
CREATE TABLE IF NOT EXISTS download_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id       TEXT NOT NULL,
    version       TEXT NOT NULL,
    architecture  TEXT NOT NULL,
    user_id       INTEGER,
    ip_hash       TEXT,
    user_agent    TEXT,
    downloaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS download_events_game_idx
ON download_events(game_id, downloaded_at);

CREATE INDEX IF NOT EXISTS download_events_arch_idx
ON download_events(architecture);
"""

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


CLIENT_CLASSES = ("prg32", "browser", "tool", "other")


def client_class(user_agent: str | None) -> str:
    """Reduce a User-Agent to a coarse client class.

    Only this class is stored (data minimisation): it answers "do downloads
    come from consoles and PRG32 tools or from browsers?" without keeping a
    browser fingerprint.
    """
    agent = str(user_agent or "").lower()
    if "prg32" in agent or "esp32" in agent or "esp-idf" in agent or "qemu" in agent:
        return "prg32"
    if "mozilla" in agent:
        return "browser"
    if any(name in agent for name in ("curl", "wget", "python", "httpie", "go-http", "node")):
        return "tool"
    return "other"


def init_stats_db() -> None:
    db = get_db()
    db.executescript(STATS_SCHEMA)
    # Older releases stored the raw User-Agent; keep only its class.
    legacy = db.execute(
        "SELECT DISTINCT user_agent FROM download_events WHERE user_agent NOT IN (?, ?, ?, ?)",
        CLIENT_CLASSES,
    ).fetchall()
    for row in legacy:
        db.execute(
            "UPDATE download_events SET user_agent = ? WHERE user_agent IS ?",
            (client_class(row["user_agent"]), row["user_agent"]),
        )
    db.commit()


def _hash_ip(remote_addr: str | None) -> str:
    # Keyed pseudonymisation prevents cheap reversal of the small IPv4 address
    # space while still allowing short-lived aggregate telemetry.
    return hmac.new(
        str(current_app.config["SECRET_KEY"]).encode("utf-8"),
        str(remote_addr or "").encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def record_download(game_id: str, version: str, architecture: str) -> None:
    principal = current_principal()
    get_db().execute(
        """
        INSERT INTO download_events(game_id, version, architecture, user_id, ip_hash, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            game_id,
            version,
            architecture,
            principal.id if principal.authenticated else None,
            _hash_ip(request.remote_addr),
            client_class(request.headers.get("User-Agent", "")),
        ),
    )
    get_db().commit()


def _date_param(name: str) -> str | None:
    value = request.args.get(name, "").strip()
    if not value:
        return None
    if not DATE_RE.fullmatch(value):
        return None
    return value


def _granularity() -> str:
    value = request.args.get("granularity", "day").strip().lower()
    if value not in ("day", "week", "month"):
        return "day"
    return value


def _limit(default: int = 30, maximum: int = 365) -> int:
    return min(max(request.args.get("limit", default=default, type=int), 1), maximum)


def _period_expression(granularity: str) -> str:
    if granularity == "month":
        return "substr(downloaded_at, 1, 7) || '-01'"
    if granularity == "week":
        return "date(downloaded_at, 'weekday 0', '-6 days')"
    return "date(downloaded_at)"


def _filters() -> tuple[list[str], list[Any]]:
    where: list[str] = []
    params: list[Any] = []
    since = _date_param("since")
    until = _date_param("until")
    if since:
        where.append("date(downloaded_at) >= date(?)")
        params.append(since)
    if until:
        where.append("date(downloaded_at) <= date(?)")
        params.append(until)
    return where, params


def download_summary(store: GameStore, *, game_id: str | None = None) -> dict[str, Any]:
    granularity = _granularity()
    limit = _limit()
    where, params = _filters()
    if game_id:
        where.append("game_id = ?")
        params.append(game_id)
    where_sql = "WHERE " + " AND ".join(where) if where else ""
    period = _period_expression(granularity)
    db = get_db()
    rows = db.execute(
        f"""
        SELECT {period} AS bucket, COUNT(*) AS downloads
        FROM download_events
        {where_sql}
        GROUP BY bucket
        ORDER BY bucket DESC
        LIMIT ?
        """,
        (*params, limit),
    ).fetchall()
    series = [
        {"date": str(row["bucket"]), "downloads": int(row["downloads"])}
        for row in reversed(rows)
    ]
    total_row = db.execute(
        f"SELECT COUNT(*) AS total FROM download_events {where_sql}",
        params,
    ).fetchone()
    top_rows = db.execute(
        f"""
        SELECT game_id, COUNT(*) AS downloads
        FROM download_events
        {where_sql}
        GROUP BY game_id
        ORDER BY downloads DESC, game_id ASC
        LIMIT 10
        """,
        params,
    ).fetchall()
    top_games = []
    for row in top_rows:
        title = str(row["game_id"])
        last_published = ""
        try:
            game = store.public_game(str(row["game_id"]))
            title = game["title"]
            last_published = game.get("updated_at", "")
        except StoreError:
            pass
        top_games.append(
            {
                "id": str(row["game_id"]),
                "title": title,
                "downloads": int(row["downloads"]),
                "last_published": last_published,
            }
        )
    return {
        "series": series,
        "total": int(total_row["total"] if total_row else 0),
        "top_games": top_games,
    }


def game_download_breakdown(game_id: str) -> dict[str, Any]:
    db = get_db()
    rows = db.execute(
        """
        SELECT architecture, COUNT(*) AS downloads
        FROM download_events
        WHERE game_id = ?
        GROUP BY architecture
        ORDER BY downloads DESC, architecture ASC
        """,
        (game_id,),
    ).fetchall()
    total = sum(int(row["downloads"]) for row in rows)
    return {
        "id": game_id,
        "total": total,
        "architectures": [
            {"architecture": str(row["architecture"]), "downloads": int(row["downloads"])}
            for row in rows
        ],
    }


def _architecture_totals() -> list[tuple[str, int]]:
    rows = get_db().execute(
        """
        SELECT architecture, COUNT(*) AS downloads
        FROM download_events
        GROUP BY architecture
        ORDER BY downloads DESC, architecture ASC
        """
    ).fetchall()
    return [(str(row["architecture"]), int(row["downloads"])) for row in rows]


def _active_runs_last_week() -> int:
    cutoff = int(time.time()) - 7 * 24 * 60 * 60
    row = get_db().execute(
        "SELECT COUNT(*) AS count FROM runs WHERE created_at >= ?",
        (cutoff,),
    ).fetchone()
    return int(row["count"] if row else 0)


def _top_scores() -> list[dict[str, Any]]:
    limit = _limit(default=20, maximum=100)
    rows = get_db().execute(
        """
        SELECT game, player, score, created_at, submitted_by
        FROM scores
        ORDER BY score DESC, created_at ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def _runs_summary() -> dict[str, Any]:
    total = get_db().execute("SELECT COUNT(*) AS count FROM runs").fetchone()
    finished = get_db().execute(
        "SELECT COUNT(*) AS count FROM runs WHERE finished_at IS NOT NULL"
    ).fetchone()
    return {
        "total": int(total["count"] if total else 0),
        "finished": int(finished["count"] if finished else 0),
        "active_last_7_days": _active_runs_last_week(),
    }


def _count(sql: str, params: tuple[Any, ...] = ()) -> int:
    try:
        row = get_db().execute(sql, params).fetchone()
    except Exception as exc:  # optional tables may not exist yet
        if "no such table" in str(exc):
            return 0
        raise
    return int(row[0] if row and row[0] is not None else 0)


def _grouped(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[str, int]]:
    try:
        rows = get_db().execute(sql, params).fetchall()
    except Exception as exc:
        if "no such table" in str(exc):
            return []
        raise
    return [(str(row[0] if row[0] is not None else "unknown"), int(row[1])) for row in rows]


def _directory_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def admin_statistics(store: GameStore) -> dict[str, Any]:
    """Operational figures for administrators (no per-person data)."""
    games = store.list_games()
    index = store.load_index().get("games", {})
    versions = sum(len(game.get("versions", {})) for game in index.values())
    variants = sum(
        len(version.get("architectures", {}))
        for game in index.values()
        for version in game.get("versions", {}).values()
    )
    previews = sum(
        1
        for game in index.values()
        for version in game.get("versions", {}).values()
        if isinstance(version.get("preview"), dict)
    )
    hub = current_app.extensions.get("prg32_multiplayer_hub")
    multiplayer = hub.status() if hub is not None else {}
    from .logs import level_counts

    return {
        "catalog": {
            "games": len(games),
            "versions": versions,
            "variants": variants,
            "previews": previews,
            "storage_bytes": _directory_size(store.cartridge_dir),
            "pending_storage_bytes": _directory_size(store.data_dir / "pending"),
            "architectures": _grouped(
                "SELECT architecture, COUNT(*) FROM download_events GROUP BY architecture ORDER BY 2 DESC"
            ),
        },
        "submissions": dict(
            _grouped("SELECT status, COUNT(*) FROM cartridge_submissions GROUP BY status ORDER BY status")
        ),
        "users": {
            "total": _count("SELECT COUNT(*) FROM users"),
            "by_role": _grouped("SELECT role, COUNT(*) FROM users GROUP BY role ORDER BY 2 DESC"),
            "by_provider": _grouped(
                "SELECT COALESCE(external_provider, 'local'), COUNT(*) FROM users GROUP BY 1 ORDER BY 2 DESC"
            ),
            "new_30_days": _count("SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-30 days')"),
            "active_30_days": _count(
                "SELECT COUNT(*) FROM users WHERE last_login IS NOT NULL "
                "AND replace(substr(last_login, 1, 19), 'T', ' ') >= datetime('now', '-30 days')"
            ),
        },
        "downloads": {
            "total": _count("SELECT COUNT(*) FROM download_events"),
            "last_7_days": _count("SELECT COUNT(*) FROM download_events WHERE downloaded_at >= datetime('now', '-7 days')"),
            "last_30_days": _count("SELECT COUNT(*) FROM download_events WHERE downloaded_at >= datetime('now', '-30 days')"),
            "signed_in": _count("SELECT COUNT(*) FROM download_events WHERE user_id IS NOT NULL"),
            "by_client": _grouped(
                "SELECT user_agent, COUNT(*) FROM download_events GROUP BY user_agent ORDER BY 2 DESC"
            ),
        },
        "scores": {
            "total": _count("SELECT COUNT(*) FROM scores"),
            "games": _count("SELECT COUNT(DISTINCT game) FROM scores"),
            "players": _count("SELECT COUNT(DISTINCT player) FROM scores"),
        },
        "runs": _runs_summary(),
        "multiplayer": multiplayer,
        "log_levels_7_days": level_counts(7),
    }


def register_stats_routes(app: Flask, store: GameStore) -> None:
    @app.before_request
    def before_stats_request() -> None:
        init_schema_once("stats", init_stats_db)

    @app.get("/api/stats/downloads")
    def api_stats_downloads():
        return jsonify(download_summary(store))

    @app.get("/api/stats/downloads/<game_id>")
    def api_stats_game_downloads(game_id: str):
        body = game_download_breakdown(game_id)
        body["series"] = download_summary(store, game_id=game_id)["series"]
        return jsonify(body)

    @app.get("/api/stats/scores")
    def api_stats_scores():
        return jsonify({"scores": _top_scores()})

    @app.get("/api/stats/runs")
    def api_stats_runs():
        return jsonify(_runs_summary())

    @app.get("/api/admin/stats")
    @admin_required
    def api_admin_stats():
        return jsonify({"ok": True, "stats": admin_statistics(store)})

    @app.get("/admin/stats")
    @admin_required
    def admin_stats_page():
        stats = admin_statistics(store)
        primary = get_setting("theme_primary_color", "#1a73e8")
        summary = download_summary(store)
        return render_template(
            "admin_stats.html",
            stats=stats,
            summary=summary,
            trend_chart=charts.line_chart(
                [{"x": item["date"], "y": item["downloads"]} for item in summary["series"]],
                x_label="Date",
                y_label="Downloads",
                color=primary,
                title="Downloads per day",
            ),
            client_chart=charts.bar_chart(stats["downloads"]["by_client"], color=primary, title="Downloads by client"),
            role_chart=charts.bar_chart(stats["users"]["by_role"], color=primary, title="Accounts by role"),
            submission_chart=charts.bar_chart(
                sorted(stats["submissions"].items()), color=primary, title="Submissions by status"
            ),
        )

    @app.get("/stats")
    def stats_page():
        summary = download_summary(store)
        primary = get_setting("theme_primary_color", "#1a73e8")
        series = [
            {"x": item["date"], "y": item["downloads"]}
            for item in summary["series"]
        ]
        trend_chart = charts.line_chart(
            series,
            x_label="Date",
            y_label="Downloads",
            color=primary,
            title="Download trend",
        )
        arch_chart = charts.bar_chart(
            _architecture_totals(),
            color=primary,
            title="Architecture downloads",
        )
        return render_template(
            "stats.html",
            summary=summary,
            trend_chart=trend_chart,
            arch_chart=arch_chart,
            active_runs_last_week=_active_runs_last_week(),
            query={
                "since": _date_param("since") or "",
                "until": _date_param("until") or "",
                "granularity": _granularity(),
            },
        )
