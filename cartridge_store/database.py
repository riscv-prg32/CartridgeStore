"""Shared SQLite helpers for Cartridge Store service data."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Callable

from flask import current_app, g


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        db_path = Path(current_app.config["DATABASE"])
        db_path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(db_path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        g.db = db
    return g.db


def init_schema_once(name: str, init: Callable[[], None]) -> None:
    """Run a schema initializer once per app and database path.

    The initializers are idempotent, but running them on every request costs
    several SQLite commits and causes lock contention under load.
    """
    ready = current_app.extensions.setdefault("prg32_schema_ready", set())
    key = (str(current_app.config["DATABASE"]), name)
    if key in ready:
        return
    init()
    ready.add(key)


def reset_schema_cache() -> None:
    """Forget initialized schemas, e.g. after the database file is replaced."""
    current_app.extensions.pop("prg32_schema_ready", None)


def table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    rows = db.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(row["name"]) for row in rows}


def add_column_if_missing(
    db: sqlite3.Connection,
    table: str,
    column: str,
    declaration: str,
) -> None:
    if column not in table_columns(db, table):
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")


def close_db(error: BaseException | None = None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()
