"""Score API compatible with the standalone PRG32 ScoreServer."""

from __future__ import annotations

import time

from flask import Flask, jsonify, request

from .database import get_db


def init_scores_db() -> None:
    db = get_db()
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game TEXT NOT NULL,
            player TEXT NOT NULL,
            score INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        )
        """
    )
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
        limit = min(max(request.args.get("limit", default=20, type=int), 1), 100)
        db = get_db()
        if game:
            rows = db.execute(
                """
                SELECT game, player, score, created_at
                FROM scores
                WHERE game = ?
                ORDER BY score DESC, created_at ASC
                LIMIT ?
                """,
                (game, limit),
            ).fetchall()
        else:
            rows = db.execute(
                """
                SELECT game, player, score, created_at
                FROM scores
                ORDER BY score DESC, created_at ASC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return jsonify([dict(row) for row in rows])

    @app.post("/api/scores")
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
            INSERT INTO scores(game, player, score, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (game, player, score, int(time.time())),
        )
        db.commit()
        return jsonify({"ok": True})
