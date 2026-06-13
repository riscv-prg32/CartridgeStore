"""Score API compatible with the standalone PRG32 ScoreServer."""

from __future__ import annotations

import time

from flask import Flask, jsonify, render_template, request

from .auth import current_principal, login_required
from .database import add_column_if_missing, get_db


def init_scores_db() -> None:
    db = get_db()
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game TEXT NOT NULL,
            player TEXT NOT NULL,
            score INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            submitted_by TEXT NOT NULL DEFAULT ''
        )
        """
    )
    add_column_if_missing(db, "scores", "submitted_by", "TEXT NOT NULL DEFAULT ''")
    db.execute(
        "CREATE INDEX IF NOT EXISTS scores_game_score_idx "
        "ON scores(game, score DESC, created_at ASC)"
    )
    db.commit()


def register_score_routes(app: Flask) -> None:
    @app.before_request
    def before_score_request() -> None:
        init_scores_db()

    @app.get("/api/scores")
    def list_scores():
        game = request.args.get("game")
        player = request.args.get("player")
        limit = min(max(request.args.get("limit", default=20, type=int), 1), 100)
        db = get_db()
        where = []
        params: list[object] = []
        if game:
            where.append("game = ?")
            params.append(game)
        if player:
            where.append("player = ?")
            params.append(player)
        where_sql = "WHERE " + " AND ".join(where) if where else ""
        rows = db.execute(
            f"""
            SELECT game, player, score, created_at, submitted_by
            FROM scores
            {where_sql}
            ORDER BY score DESC, created_at ASC
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()
        return jsonify([dict(row) for row in rows])

    @app.get("/scores")
    def score_page():
        game = request.args.get("game", "").strip()
        player = request.args.get("player", "").strip()
        limit = min(max(request.args.get("limit", default=50, type=int), 1), 100)
        db = get_db()
        where = []
        params: list[object] = []
        if game:
            where.append("game = ?")
            params.append(game)
        if player:
            where.append("player = ?")
            params.append(player)
        where_sql = "WHERE " + " AND ".join(where) if where else ""
        rows = db.execute(
            f"""
            SELECT game, player, score, created_at, submitted_by
            FROM scores
            {where_sql}
            ORDER BY score DESC, created_at ASC
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()
        return render_template(
            "scores.html",
            scores=[dict(row) for row in rows],
            game=game,
            player=player,
            limit=limit,
        )

    @app.post("/api/scores")
    @login_required
    def submit_score():
        data = request.get_json(silent=True) or {}
        game = str(data.get("game", "")).strip()[:24]
        player = str(data.get("player", "")).strip()[:24]
        try:
            score = int(data.get("score"))
        except (TypeError, ValueError):
            score = -1

        if not game or not player or score < 0:
            return jsonify({"ok": False, "error": "expected game, player, score"}), 400

        db = get_db()
        db.execute(
            """
            INSERT INTO scores(game, player, score, created_at, submitted_by)
            VALUES (?, ?, ?, ?, ?)
            """,
            (game, player, score, int(time.time()), current_principal().name),
        )
        db.commit()
        return jsonify({"ok": True})
