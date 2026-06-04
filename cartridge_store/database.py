"""Shared SQLite storage for PRG32 score and metrics services."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from flask import current_app, g


SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game TEXT NOT NULL,
    player TEXT NOT NULL,
    score INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    submitted_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS scores_game_score_idx
ON scores(game, score DESC, created_at ASC);

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    target TEXT NOT NULL,
    display_backend TEXT NOT NULL DEFAULT '',
    firmware_version TEXT NOT NULL DEFAULT '',
    firmware_git_sha TEXT NOT NULL DEFAULT '',
    game_name TEXT NOT NULL DEFAULT '',
    sample_period_frames INTEGER NOT NULL DEFAULT 1,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    dropped_samples INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    submitted_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    frame INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    update_us INTEGER NOT NULL,
    draw_us INTEGER NOT NULL,
    present_us INTEGER NOT NULL,
    frame_us INTEGER NOT NULL,
    heap_free INTEGER NOT NULL,
    heap_min_free INTEGER NOT NULL,
    input_mask INTEGER NOT NULL,
    fps_x100 INTEGER NOT NULL,
    upload_queue_depth INTEGER NOT NULL,
    deadline_missed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(run_id, frame)
);

CREATE INDEX IF NOT EXISTS samples_run_frame_idx ON samples(run_id, frame);
CREATE INDEX IF NOT EXISTS samples_run_frame_time_idx ON samples(run_id, frame_us);
"""


def get_db() -> sqlite3.Connection:
    if "prg32_services_db" not in g:
        db_path = Path(current_app.config["SERVICES_DB"])
        db_path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(db_path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        g.prg32_services_db = db
    return g.prg32_services_db


def _columns(db: sqlite3.Connection, table: str) -> set[str]:
    rows = db.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(row["name"]) for row in rows}


def _add_column_if_missing(
    db: sqlite3.Connection,
    table: str,
    column: str,
    declaration: str,
) -> None:
    if column not in _columns(db, table):
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")


def init_db() -> None:
    db = get_db()
    db.executescript(SCHEMA_SQL)
    _add_column_if_missing(db, "scores", "submitted_by", "TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(db, "runs", "submitted_by", "TEXT NOT NULL DEFAULT ''")
    db.commit()


def close_db(error: BaseException | None = None) -> None:
    db = g.pop("prg32_services_db", None)
    if db is not None:
        db.close()
