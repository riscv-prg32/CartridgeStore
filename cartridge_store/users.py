"""User profile and metrics dashboard routes."""

from __future__ import annotations

import json
from typing import Any

from flask import Flask, Response, jsonify, render_template, request

from . import charts
from .auth import current_principal, role_at_least
from .database import get_db
from .metrics_report import summarize_samples
from .settings import get_setting


def _row_dict(row: Any | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def find_user(username: str) -> dict[str, Any] | None:
    return _row_dict(
        get_db().execute(
            "SELECT id, username, email, role, created_at, last_login FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    )


def can_view_user(user: dict[str, Any]) -> bool:
    principal = current_principal()
    if not principal.authenticated:
        return False
    return principal.id == int(user["id"]) or role_at_least(principal.role, "admin")


def can_view_run(run: dict[str, Any]) -> bool:
    owner = run.get("user_id")
    if owner is None:
        return True
    principal = current_principal()
    if not principal.authenticated:
        return False
    return principal.id == int(owner) or role_at_least(principal.role, "admin")


def _forbidden():
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "forbidden"}), 403
    return render_template("error.html", error="Forbidden"), 403


def load_run(run_id: str) -> dict[str, Any] | None:
    return _row_dict(get_db().execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone())


def load_samples(run_id: str) -> list[dict[str, Any]]:
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


def run_json_response(run_id: str):
    run = load_run(run_id)
    if not run:
        return jsonify({"ok": False, "error": "run_id not found"}), 404
    if not can_view_run(run):
        return _forbidden()
    samples = load_samples(run_id)
    payload = {
        "ok": True,
        "run": run,
        "samples": samples,
        "summary": summarize_samples(samples),
    }
    response = Response(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        mimetype="application/json",
    )
    response.headers["Content-Disposition"] = f"attachment; filename=run-{run_id}.json"
    return response


def _run_rows_for_user(user_id: int, limit: int, offset: int) -> list[dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT runs.*,
               COUNT(samples.id) AS sample_count,
               AVG(samples.frame_us) AS mean_frame_us
        FROM runs
        LEFT JOIN samples ON samples.run_id = runs.run_id
        WHERE runs.user_id = ?
        GROUP BY runs.run_id
        ORDER BY runs.created_at DESC
        LIMIT ? OFFSET ?
        """,
        (user_id, limit, offset),
    ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        samples = load_samples(str(item["run_id"]))
        summary = summarize_samples(samples)
        item["mean_frame_us"] = summary["frame_us_avg"]
        item["p95_frame_us"] = summary["frame_us_p95"]
        result.append(item)
    return result


def register_user_routes(app: Flask) -> None:
    @app.get("/users/<username>")
    def public_user_profile(username: str):
        user = find_user(username)
        if not user:
            return render_template("error.html", error="User not found"), 404
        run_count = get_db().execute(
            "SELECT COUNT(*) AS count FROM runs WHERE user_id = ?",
            (user["id"],),
        ).fetchone()
        return render_template(
            "user_profile.html",
            profile_user=user,
            run_count=int(run_count["count"] if run_count else 0),
            can_view_runs=can_view_user(user),
        )

    @app.get("/users/<username>/runs")
    def user_runs(username: str):
        user = find_user(username)
        if not user:
            return render_template("error.html", error="User not found"), 404
        if not can_view_user(user):
            return _forbidden()
        page = max(request.args.get("page", default=1, type=int), 1)
        per_page = 25
        runs = _run_rows_for_user(int(user["id"]), per_page, (page - 1) * per_page)
        return render_template("user_runs.html", profile_user=user, runs=runs, page=page)

    @app.get("/users/<username>/runs/<run_id>")
    def user_run_detail(username: str, run_id: str):
        user = find_user(username)
        if not user:
            return render_template("error.html", error="User not found"), 404
        run = load_run(run_id)
        if not run:
            return render_template("error.html", error="Run not found"), 404
        if int(run.get("user_id") or -1) != int(user["id"]):
            return render_template("error.html", error="Run not found"), 404
        if not can_view_run(run):
            return _forbidden()
        samples = load_samples(run_id)
        summary = summarize_samples(samples)
        primary = get_setting("theme_primary_color", "#1a73e8")
        series = [{"x": sample["frame"], "y": sample["frame_us"]} for sample in samples]
        frame_chart = charts.line_chart(
            series,
            x_label="Frame",
            y_label="frame_us",
            color=primary,
            title=f"Frame time for {run_id}",
            reference_lines=[
                {"y": summary["frame_us_avg"], "label": "mean"},
                {"y": summary["frame_us_p95"], "label": "p95"},
            ],
        )
        return render_template(
            "user_run_detail.html",
            profile_user=user,
            run=run,
            samples=samples,
            summary=summary,
            frame_chart=frame_chart,
        )
