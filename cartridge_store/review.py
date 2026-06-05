"""Pending cartridge submission review workflow."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import shutil
from typing import Any

from flask import Flask, jsonify, redirect, render_template, request, url_for

from . import prg32_format as fmt
from .auth import Principal, current_principal, editor_required
from .database import get_db
from .store import GameStore, StoreError, safe_game_id, safe_version


REVIEW_SCHEMA = """
CREATE TABLE IF NOT EXISTS cartridge_submissions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id              TEXT NOT NULL,
    version              TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'pending',
    submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    submitted_by         TEXT NOT NULL DEFAULT '',
    reviewed_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by          TEXT NOT NULL DEFAULT '',
    pending_dir          TEXT NOT NULL DEFAULT '',
    metadata_json        TEXT NOT NULL,
    architectures_json   TEXT NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at          TEXT
);

CREATE INDEX IF NOT EXISTS cartridge_submissions_status_idx
ON cartridge_submissions(status, created_at);
"""

EDITABLE_METADATA_FIELDS = {
    "title",
    "summary",
    "description",
    "tags",
    "license",
    "homepage",
    "repository",
}


def init_review_db() -> None:
    db = get_db()
    db.executescript(REVIEW_SCHEMA)
    db.commit()


def _data_dir() -> Path:
    from flask import current_app

    return Path(current_app.config["DATA_DIR"])


def _row_dict(row: Any | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def create_submission(prepared: list[dict[str, Any]]) -> dict[str, Any]:
    if not prepared:
        raise StoreError("bundle did not contain any cartridge variants")
    metadata = _common_metadata(prepared)
    principal = current_principal()
    db = get_db()
    cursor = db.execute(
        """
        INSERT INTO cartridge_submissions(
            game_id, version, submitted_by_user_id, submitted_by,
            metadata_json, architectures_json
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            metadata["id"],
            metadata["version"],
            principal.id,
            principal.name,
            _json(metadata),
            "[]",
        ),
    )
    submission_id = int(cursor.lastrowid)
    relative_dir = Path("pending") / str(submission_id)
    pending_dir = _data_dir() / relative_dir
    architectures: list[dict[str, str]] = []
    try:
        pending_dir.mkdir(parents=True, exist_ok=False)
        for item in prepared:
            filename = f"{item['architecture']}.prg32"
            stored = relative_dir / filename
            (pending_dir / filename).write_bytes(item["image"])
            architectures.append(
                {
                    "architecture": item["architecture"],
                    "file": item["file"],
                    "stored": stored.as_posix(),
                }
            )
        db.execute(
            """
            UPDATE cartridge_submissions
            SET pending_dir = ?, architectures_json = ?
            WHERE id = ?
            """,
            (relative_dir.as_posix(), _json(architectures), submission_id),
        )
        db.commit()
    except Exception:
        db.execute("DELETE FROM cartridge_submissions WHERE id = ?", (submission_id,))
        db.commit()
        shutil.rmtree(pending_dir, ignore_errors=True)
        raise
    return load_submission(submission_id) or {}


def _common_metadata(prepared: list[dict[str, Any]]) -> dict[str, Any]:
    manifest = deepcopy(prepared[0]["manifest"])
    manifest.pop("assets", None)
    manifest.pop("architectures", None)
    manifest.pop("colophon", None)
    manifest.setdefault("summary", "")
    fmt.validate_metadata(manifest)
    return manifest


def list_submissions(status: str | None = None) -> list[dict[str, Any]]:
    db = get_db()
    if status:
        rows = db.execute(
            """
            SELECT *
            FROM cartridge_submissions
            WHERE status = ?
            ORDER BY created_at DESC, id DESC
            """,
            (status,),
        ).fetchall()
    else:
        rows = db.execute(
            """
            SELECT *
            FROM cartridge_submissions
            ORDER BY created_at DESC, id DESC
            """
        ).fetchall()
    return [_inflate_submission(dict(row)) for row in rows]


def load_submission(submission_id: int) -> dict[str, Any] | None:
    row = get_db().execute(
        "SELECT * FROM cartridge_submissions WHERE id = ?",
        (submission_id,),
    ).fetchone()
    if row is None:
        return None
    return _inflate_submission(dict(row))


def _inflate_submission(row: dict[str, Any]) -> dict[str, Any]:
    row["metadata"] = json.loads(row["metadata_json"])
    row["architectures"] = json.loads(row["architectures_json"])
    return row


def editable_metadata_from_form(original: dict[str, Any]) -> dict[str, Any]:
    metadata = deepcopy(original)
    for field in ("title", "summary", "description", "license", "homepage", "repository"):
        if field in request.form:
            metadata[field] = request.form.get(field, "").strip()
    if "tags" in request.form:
        metadata["tags"] = [
            tag.strip()
            for tag in request.form.get("tags", "").split(",")
            if tag.strip()
        ]
    metadata["id"] = original["id"]
    metadata["version"] = original["version"]
    metadata["authors"] = original.get("authors", [])
    return metadata


def editable_metadata_from_json(original: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    forbidden = {"id", "version", "authors"}
    for field in forbidden:
        if field in updates and updates[field] != original.get(field):
            raise StoreError(f"metadata.{field} cannot be changed during review")
    metadata = deepcopy(original)
    for field in EDITABLE_METADATA_FIELDS:
        if field in updates:
            metadata[field] = updates[field]
    metadata["id"] = original["id"]
    metadata["version"] = original["version"]
    metadata["authors"] = original.get("authors", [])
    return metadata


def approve_submission(store: GameStore, submission_id: int, metadata: dict[str, Any]) -> dict[str, Any]:
    submission = load_submission(submission_id)
    if submission is None:
        raise StoreError("submission not found")
    if submission["status"] != "pending":
        raise StoreError("submission is not pending")

    metadata = _validated_review_metadata(submission["metadata"], metadata)
    prepared = []
    for item in submission["architectures"]:
        path = _data_dir() / item["stored"]
        if not path.is_file():
            raise StoreError("pending cartridge file is missing")
        parsed = fmt.parse_cartridge(path.read_bytes())
        variant_metadata = _metadata_for_variant(parsed.metadata or {}, metadata)
        image = fmt.build_cartridge(
            parsed.legacy_payload,
            metadata=variant_metadata,
            icon=parsed.icon or b"",
            screenshot=parsed.screenshot,
            signature=parsed.signature,
            colophon=parsed.colophon,
            architecture=item["architecture"],
        )
        prepared.append(
            {
                "architecture": item["architecture"],
                "image": image,
                "parsed": fmt.parse_cartridge(image),
            }
        )

    _publish_prepared(store, prepared)
    reviewer = current_principal()
    get_db().execute(
        """
        UPDATE cartridge_submissions
        SET status = 'verified',
            metadata_json = ?,
            reviewed_by_user_id = ?,
            reviewed_by = ?,
            reviewed_at = datetime('now')
        WHERE id = ?
        """,
        (_json(metadata), reviewer.id, reviewer.name, submission_id),
    )
    get_db().commit()
    if submission["pending_dir"]:
        shutil.rmtree(_data_dir() / submission["pending_dir"], ignore_errors=True)
    return load_submission(submission_id) or {}


def reject_submission(submission_id: int, reviewer: Principal | None = None) -> dict[str, Any]:
    submission = load_submission(submission_id)
    if submission is None:
        raise StoreError("submission not found")
    if submission["status"] != "pending":
        raise StoreError("submission is not pending")
    reviewer = reviewer or current_principal()
    get_db().execute(
        """
        UPDATE cartridge_submissions
        SET status = 'rejected',
            reviewed_by_user_id = ?,
            reviewed_by = ?,
            reviewed_at = datetime('now')
        WHERE id = ?
        """,
        (reviewer.id, reviewer.name, submission_id),
    )
    get_db().commit()
    if submission["pending_dir"]:
        shutil.rmtree(_data_dir() / submission["pending_dir"], ignore_errors=True)
    return load_submission(submission_id) or {}


def _validated_review_metadata(original: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    metadata = deepcopy(metadata)
    metadata["id"] = original["id"]
    metadata["version"] = original["version"]
    metadata["authors"] = original.get("authors", [])
    fmt.validate_metadata(metadata)
    return metadata


def _metadata_for_variant(original: dict[str, Any], reviewed: dict[str, Any]) -> dict[str, Any]:
    metadata = deepcopy(original)
    for field in EDITABLE_METADATA_FIELDS:
        if field in reviewed:
            metadata[field] = reviewed[field]
    metadata["id"] = original["id"]
    metadata["version"] = original["version"]
    metadata["authors"] = original.get("authors", [])
    return metadata


def _publish_prepared(store: GameStore, prepared: list[dict[str, Any]]) -> None:
    index_existed = store.index_path.exists()
    index_backup = store.index_path.read_bytes() if index_existed else b""
    file_backups: dict[Path, bytes | None] = {}
    try:
        for item in prepared:
            metadata = item["parsed"].metadata or {}
            game_id = safe_game_id(metadata["id"])
            version = safe_version(metadata["version"])
            path = store.cartridge_dir / game_id / version / f"{item['architecture']}.prg32"
            if path not in file_backups:
                file_backups[path] = path.read_bytes() if path.exists() else None
            store.publish(
                item["image"],
                item["parsed"],
                architecture=item["architecture"],
                publisher=current_principal().name,
            )
    except Exception:
        if index_existed:
            store.index_path.write_bytes(index_backup)
        elif store.index_path.exists():
            store.index_path.unlink()
        for path, data in file_backups.items():
            if data is None:
                if path.exists():
                    path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        raise


def register_review_routes(app: Flask, store: GameStore) -> None:
    @app.before_request
    def before_review_request() -> None:
        init_review_db()

    @app.get("/editor/submissions")
    @editor_required
    def editor_submissions():
        status = request.args.get("status") or "pending"
        return render_template(
            "editor_submissions.html",
            submissions=list_submissions(status if status != "all" else None),
            status=status,
        )

    @app.get("/editor/submissions/<int:submission_id>")
    @editor_required
    def editor_submission_detail(submission_id: int):
        submission = load_submission(submission_id)
        if submission is None:
            return render_template("error.html", error="Submission not found"), 404
        return render_template("editor_submission.html", submission=submission)

    @app.post("/editor/submissions/<int:submission_id>/verify")
    @editor_required
    def editor_verify_submission(submission_id: int):
        submission = load_submission(submission_id)
        if submission is None:
            return render_template("error.html", error="Submission not found"), 404
        metadata = editable_metadata_from_form(submission["metadata"])
        approve_submission(store, submission_id, metadata)
        return redirect(url_for("editor_submissions"))

    @app.post("/editor/submissions/<int:submission_id>/reject")
    @editor_required
    def editor_reject_submission(submission_id: int):
        reject_submission(submission_id)
        return redirect(url_for("editor_submissions"))

    @app.get("/api/submissions")
    @editor_required
    def api_submissions():
        status = request.args.get("status") or "pending"
        return jsonify({"ok": True, "submissions": list_submissions(status if status != "all" else None)})

    @app.get("/api/submissions/<int:submission_id>")
    @editor_required
    def api_submission_detail(submission_id: int):
        submission = load_submission(submission_id)
        if submission is None:
            return jsonify({"ok": False, "error": "submission not found"}), 404
        return jsonify({"ok": True, "submission": submission})

    @app.post("/api/submissions/<int:submission_id>/verify")
    @editor_required
    def api_verify_submission(submission_id: int):
        submission = load_submission(submission_id)
        if submission is None:
            return jsonify({"ok": False, "error": "submission not found"}), 404
        data = request.get_json(silent=True) or {}
        metadata = editable_metadata_from_json(submission["metadata"], data.get("metadata", {}))
        verified = approve_submission(store, submission_id, metadata)
        return jsonify({"ok": True, "submission": verified})

    @app.post("/api/submissions/<int:submission_id>/reject")
    @editor_required
    def api_reject_submission(submission_id: int):
        rejected = reject_submission(submission_id)
        return jsonify({"ok": True, "submission": rejected})
