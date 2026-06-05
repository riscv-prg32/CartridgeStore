"""Metrics API compatible with the standalone PRG32 MetricsServer."""

from __future__ import annotations

import csv
import io
import time
from typing import Any

from flask import Flask, Response, current_app, jsonify, request

from .auth import current_principal, require_role
from .database import add_column_if_missing, get_db
from .metrics_report import generate_markdown_report, list_runs, summarize_samples


METRICS_SCHEMA = """
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


def init_metrics_db() -> None:
    db = get_db()
    db.executescript(METRICS_SCHEMA)
    add_column_if_missing(db, "runs", "submitted_by", "TEXT NOT NULL DEFAULT ''")
    db.commit()


def _clean_text(data: dict[str, Any], key: str, max_len: int, default: str = "") -> str:
    value = data.get(key, default)
    if value is None:
        value = default
    return str(value).strip()[:max_len]


def _int_value(data: dict[str, Any], key: str, default: int = 0, minimum: int = 0) -> int:
    try:
        value = int(data.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(value, minimum)


def _row_dict(row: Any | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def _samples_for_run(run_id: str) -> list[dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT frame, timestamp_ms, update_us, draw_us, present_us, frame_us,
               heap_free, heap_min_free, input_mask, fps_x100,
               upload_queue_depth, deadline_missed
        FROM samples
        WHERE run_id = ?
        ORDER BY frame ASC
        """,
        (run_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def register_metrics_routes(app: Flask) -> None:
    @app.before_request
    def before_metrics_request() -> None:
        init_metrics_db()

    @app.get("/api/metrics")
    def metrics_index():
        return jsonify(
            {
                "ok": True,
                "service": "PRG32 metrics",
                "endpoints": [
                    "POST /api/runs",
                    "POST /api/metrics/batch",
                    "POST /api/runs/<run_id>/finish",
                    "GET /api/runs",
                    "GET /api/runs/<run_id>",
                    "GET /api/runs/<run_id>/samples.csv",
                    "GET /api/runs/<run_id>/report.md",
                ],
            }
        )

    @app.post("/api/runs")
    @require_role("player")
    def create_run():
        data = request.get_json(silent=True) or {}
        run_id = _clean_text(data, "run_id", 96)
        board_id = _clean_text(data, "board_id", 40)
        target = _clean_text(data, "target", 24)
        if not run_id or not board_id or not target:
            return jsonify({"ok": False, "error": "expected run_id, board_id, target"}), 400

        record = {
            "run_id": run_id,
            "board_id": board_id,
            "target": target,
            "display_backend": _clean_text(data, "display_backend", 24),
            "firmware_version": _clean_text(data, "firmware_version", 32),
            "firmware_git_sha": _clean_text(data, "firmware_git_sha", 24),
            "game_name": _clean_text(data, "game_name", 40),
            "sample_period_frames": _int_value(data, "sample_period_frames", 1, 1),
            "started_at": _int_value(data, "started_ms", int(time.time() * 1000), 0),
            "submitted_by": current_principal().name,
        }

        get_db().execute(
            """
            INSERT INTO runs(
                run_id, board_id, target, display_backend, firmware_version,
                firmware_git_sha, game_name, sample_period_frames, started_at,
                submitted_by
            )
            VALUES (
                :run_id, :board_id, :target, :display_backend, :firmware_version,
                :firmware_git_sha, :game_name, :sample_period_frames, :started_at,
                :submitted_by
            )
            ON CONFLICT(run_id) DO UPDATE SET
                board_id = excluded.board_id,
                target = excluded.target,
                display_backend = excluded.display_backend,
                firmware_version = excluded.firmware_version,
                firmware_git_sha = excluded.firmware_git_sha,
                game_name = excluded.game_name,
                sample_period_frames = excluded.sample_period_frames,
                started_at = excluded.started_at,
                submitted_by = excluded.submitted_by
            """,
            record,
        )
        get_db().commit()
        return jsonify({"ok": True, "run_id": run_id})

    @app.post("/api/metrics/batch")
    @require_role("player")
    def create_batch():
        data = request.get_json(silent=True) or {}
        run_id = _clean_text(data, "run_id", 96)
        samples = data.get("samples")
        if not run_id or not isinstance(samples, list):
            return jsonify({"ok": False, "error": "expected run_id and samples"}), 400

        db = get_db()
        run = db.execute("SELECT run_id FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if not run:
            return jsonify({"ok": False, "error": "run_id not found"}), 404

        inserted = 0
        for raw_sample in samples:
            if not isinstance(raw_sample, dict):
                continue
            sample = {
                "run_id": run_id,
                "frame": _int_value(raw_sample, "frame", 0, 0),
                "timestamp_ms": _int_value(raw_sample, "timestamp_ms", 0, 0),
                "update_us": _int_value(raw_sample, "update_us", 0, 0),
                "draw_us": _int_value(raw_sample, "draw_us", 0, 0),
                "present_us": _int_value(raw_sample, "present_us", 0, 0),
                "frame_us": _int_value(raw_sample, "frame_us", 0, 0),
                "heap_free": _int_value(raw_sample, "heap_free", 0, 0),
                "heap_min_free": _int_value(raw_sample, "heap_min_free", 0, 0),
                "input_mask": _int_value(raw_sample, "input_mask", 0, 0),
                "fps_x100": _int_value(raw_sample, "fps_x100", 0, 0),
                "upload_queue_depth": _int_value(raw_sample, "upload_queue_depth", 0, 0),
                "deadline_missed": 1 if raw_sample.get("deadline_missed") else 0,
            }
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO samples(
                    run_id, frame, timestamp_ms, update_us, draw_us, present_us,
                    frame_us, heap_free, heap_min_free, input_mask, fps_x100,
                    upload_queue_depth, deadline_missed
                )
                VALUES (
                    :run_id, :frame, :timestamp_ms, :update_us, :draw_us,
                    :present_us, :frame_us, :heap_free, :heap_min_free,
                    :input_mask, :fps_x100, :upload_queue_depth, :deadline_missed
                )
                """,
                sample,
            )
            if cursor.rowcount > 0:
                inserted += 1

        dropped = _int_value(data, "dropped_samples", 0, 0)
        if dropped:
            db.execute(
                "UPDATE runs SET dropped_samples = dropped_samples + ? WHERE run_id = ?",
                (dropped, run_id),
            )
        db.commit()
        return jsonify({"ok": True, "inserted": inserted, "received": len(samples)})

    @app.post("/api/runs/<run_id>/finish")
    @require_role("player")
    def finish_run(run_id: str):
        data = request.get_json(silent=True) or {}
        finished_at = _int_value(data, "finished_ms", int(time.time() * 1000), 0)
        dropped = _int_value(data, "dropped_samples", 0, 0)
        db = get_db()
        cursor = db.execute(
            """
            UPDATE runs
            SET finished_at = ?, dropped_samples = MAX(dropped_samples, ?)
            WHERE run_id = ?
            """,
            (finished_at, dropped, run_id),
        )
        db.commit()
        if cursor.rowcount == 0:
            return jsonify({"ok": False, "error": "run_id not found"}), 404
        return jsonify({"ok": True, "run_id": run_id})

    @app.get("/api/runs")
    def runs():
        return jsonify(list_runs(current_app.config["DATABASE"]))

    @app.get("/api/runs/<run_id>")
    def run_detail(run_id: str):
        run = _row_dict(
            get_db().execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        )
        if not run:
            return jsonify({"ok": False, "error": "run_id not found"}), 404
        samples = _samples_for_run(run_id)
        return jsonify({"ok": True, "run": run, "summary": summarize_samples(samples)})

    @app.get("/api/runs/<run_id>/samples.csv")
    def samples_csv(run_id: str):
        if not get_db().execute("SELECT 1 FROM runs WHERE run_id = ?", (run_id,)).fetchone():
            return jsonify({"ok": False, "error": "run_id not found"}), 404
        samples = _samples_for_run(run_id)
        output = io.StringIO()
        fields = [
            "frame",
            "timestamp_ms",
            "update_us",
            "draw_us",
            "present_us",
            "frame_us",
            "heap_free",
            "heap_min_free",
            "input_mask",
            "fps_x100",
            "upload_queue_depth",
            "deadline_missed",
        ]
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        writer.writerows(samples)
        return Response(output.getvalue(), mimetype="text/csv")

    @app.get("/api/runs/<run_id>/report.md")
    def report_md(run_id: str):
        text = generate_markdown_report(current_app.config["DATABASE"], run_id)
        status = 200 if "was not found" not in text else 404
        return Response(text, status=status, mimetype="text/markdown")
