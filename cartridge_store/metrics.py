"""Metrics API compatible with the standalone PRG32 MetricsServer."""

from __future__ import annotations

import csv
import io
import time
from statistics import mean, median
from typing import Any

from flask import Flask, Response, jsonify, request

from .database import get_db


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
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
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


def _row_dict(row) -> dict[str, Any] | None:
    return dict(row) if row else None


def _quantile(values: list[int], q: float) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return float(values[0])
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    frac = pos - low
    return float(ordered[low] * (1.0 - frac) + ordered[high] * frac)


def summarize_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    frame_times = [int(sample["frame_us"]) for sample in samples]
    update_times = [int(sample["update_us"]) for sample in samples]
    draw_times = [int(sample["draw_us"]) for sample in samples]
    present_times = [int(sample["present_us"]) for sample in samples]
    missed = sum(1 for sample in samples if int(sample["deadline_missed"]))
    fps_values = [int(sample["fps_x100"]) / 100.0 for sample in samples]

    if not frame_times:
        return {
            "sample_count": 0,
            "frame_us_avg": 0.0,
            "frame_us_median": 0.0,
            "frame_us_p95": 0.0,
            "frame_us_max": 0,
            "update_us_avg": 0.0,
            "draw_us_avg": 0.0,
            "present_us_avg": 0.0,
            "fps_avg": 0.0,
            "deadline_missed": 0,
        }

    return {
        "sample_count": len(samples),
        "frame_us_avg": mean(frame_times),
        "frame_us_median": median(frame_times),
        "frame_us_p95": _quantile(frame_times, 0.95),
        "frame_us_max": max(frame_times),
        "update_us_avg": mean(update_times),
        "draw_us_avg": mean(draw_times),
        "present_us_avg": mean(present_times),
        "fps_avg": mean(fps_values) if fps_values else 0.0,
        "deadline_missed": missed,
    }


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


def list_runs() -> list[dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT runs.*,
               COUNT(samples.id) AS sample_count
        FROM runs
        LEFT JOIN samples ON samples.run_id = runs.run_id
        GROUP BY runs.run_id
        ORDER BY runs.created_at DESC
        """
    ).fetchall()
    return [dict(row) for row in rows]


def generate_markdown_report(run_id: str) -> str:
    run = _row_dict(
        get_db().execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
    )
    if not run:
        return f"# PRG32 Metrics Report\n\nRun `{run_id}` was not found.\n"

    samples = _samples_for_run(run_id)
    summary = summarize_samples(samples)
    dropped = int(run.get("dropped_samples") or 0)
    deadline_pct = 0.0
    if summary["sample_count"]:
        deadline_pct = 100.0 * summary["deadline_missed"] / summary["sample_count"]

    lines = [
        "# PRG32 Metrics Report",
        "",
        f"- Run: `{run_id}`",
        f"- Board: `{run['board_id']}`",
        f"- Target: `{run['target']}`",
        f"- Display: `{run['display_backend']}`",
        f"- Firmware: `{run['firmware_version']}` (`{run['firmware_git_sha']}`)",
        f"- Game: `{run['game_name']}`",
        f"- Sample period: {run['sample_period_frames']} frame(s)",
        f"- Dropped samples: {dropped}",
        "",
        "| Metric | Value |",
        "|---|---:|",
        f"| Samples | {summary['sample_count']} |",
        f"| Average frame work | {summary['frame_us_avg']:.1f} us |",
        f"| Median frame work | {summary['frame_us_median']:.1f} us |",
        f"| p95 frame work | {summary['frame_us_p95']:.1f} us |",
        f"| Max frame work | {summary['frame_us_max']} us |",
        f"| Average update | {summary['update_us_avg']:.1f} us |",
        f"| Average draw | {summary['draw_us_avg']:.1f} us |",
        f"| Average present | {summary['present_us_avg']:.1f} us |",
        f"| Average active FPS | {summary['fps_avg']:.2f} |",
        f"| Deadline misses | {summary['deadline_missed']} ({deadline_pct:.1f}%) |",
        "",
    ]
    return "\n".join(lines)


def register_metrics_routes(app: Flask) -> None:
    @app.before_request
    def before_metrics_request() -> None:
        init_metrics_db()

    @app.post("/api/runs")
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
        }

        get_db().execute(
            """
            INSERT INTO runs(
                run_id, board_id, target, display_backend, firmware_version,
                firmware_git_sha, game_name, sample_period_frames, started_at
            )
            VALUES (
                :run_id, :board_id, :target, :display_backend, :firmware_version,
                :firmware_git_sha, :game_name, :sample_period_frames, :started_at
            )
            ON CONFLICT(run_id) DO UPDATE SET
                board_id = excluded.board_id,
                target = excluded.target,
                display_backend = excluded.display_backend,
                firmware_version = excluded.firmware_version,
                firmware_git_sha = excluded.firmware_git_sha,
                game_name = excluded.game_name,
                sample_period_frames = excluded.sample_period_frames,
                started_at = excluded.started_at
            """,
            record,
        )
        get_db().commit()
        return jsonify({"ok": True, "run_id": run_id})

    @app.post("/api/metrics/batch")
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
        return jsonify(list_runs())

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
        text = generate_markdown_report(run_id)
        status = 200 if "was not found" not in text else 404
        return Response(text, status=status, mimetype="text/markdown")
