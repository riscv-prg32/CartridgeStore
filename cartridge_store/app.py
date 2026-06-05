"""Flask PWA for the PRG32 Cartrige Store."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any
from copy import deepcopy
from io import BytesIO
import zipfile

from flask import (
    Flask,
    Request as FlaskRequest,
    Response,
    abort,
    current_app,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    url_for,
)
from werkzeug.security import generate_password_hash

from . import charts, prg32_format as fmt
from .auth import (
    ROLE_LEVELS,
    admin_required,
    auth_is_configured,
    current_principal,
    groups_for_user,
    login_required,
    register_auth_routes,
    set_user_groups,
)
from .database import close_db, get_db
from .mdns import register_mdns
from .metrics import register_metrics_routes
from .multiplayer import register_multiplayer_routes
from .review import create_submission, register_review_routes
from .scores import register_score_routes
from .settings import DEFAULT_SETTINGS, get_setting, register_settings, set_setting
from .stats import game_download_breakdown, record_download, register_stats_routes
from .store import GameStore, StoreError, safe_game_id, safe_version
from .users import register_user_routes


DEFAULT_MAX_UPLOAD = 8 * 1024 * 1024


class CartridgeRequest(FlaskRequest):
    @property
    def max_content_length(self) -> int | None:
        if self.path in {"/api/publish/bundle", "/api/publish", "/publish"}:
            return int(current_app.config["BUNDLE_MAX_CONTENT_LENGTH"])
        return super().max_content_length


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    root = Path(__file__).resolve().parents[1]
    data_dir = os.environ.get("PRG32_STORE_DATA", str(root / "data"))
    database_path = os.environ.get(
        "PRG32_STORE_DB",
        os.environ.get(
            "PRG32_SCORE_DB",
            os.environ.get(
                "PRG32_METRICS_DB",
                str(Path(data_dir) / "cartrige_store.sqlite"),
            ),
        ),
    )
    app = Flask(
        __name__,
        template_folder=str(root / "templates"),
        static_folder=str(root / "static"),
    )
    app.request_class = CartridgeRequest
    secret_key = os.environ.get("SECRET_KEY", "")
    if test_config and test_config.get("SECRET_KEY"):
        secret_key = str(test_config["SECRET_KEY"])
    if not secret_key and not (test_config and test_config.get("TESTING")):
        message = "SECRET_KEY must be set before starting PRG32 Cartrige Store"
        print(message, file=sys.stderr)
        raise RuntimeError(message)
    if not secret_key:
        secret_key = "test-secret-key"
    app.config.update(
        DATA_DIR=data_dir,
        DATABASE=database_path,
        SERVICES_DB=None,
        MAX_CONTENT_LENGTH=DEFAULT_MAX_UPLOAD,
        BUNDLE_MAX_CONTENT_LENGTH=int(os.environ.get("PRG32_BUNDLE_MAX_MB", "64")) * 1024 * 1024,
        MULTIPLAYER_MAX_PEERS=int(os.environ.get("PRG32_MP_MAX_PEERS", "8")),
        STORE_NAME="PRG32 Cartrige Store",
        STORE_VERSION="1.0.0",
        USERS=None,
        SECRET_KEY=secret_key,
    )
    if test_config:
        app.config.update(test_config)
        if "DATABASE" not in test_config:
            app.config["DATABASE"] = str(
                Path(app.config["DATA_DIR"]) / "cartrige_store.sqlite"
            )
    if not app.config.get("SERVICES_DB"):
        app.config["SERVICES_DB"] = app.config["DATABASE"]

    store = GameStore(app.config["DATA_DIR"])
    app.teardown_appcontext(close_db)
    register_auth_routes(app)
    register_settings(app)
    register_score_routes(app)
    register_metrics_routes(app)
    register_multiplayer_routes(app)
    register_stats_routes(app, store)
    register_user_routes(app)
    register_review_routes(app, store)
    register_mdns(app)

    @app.errorhandler(StoreError)
    @app.errorhandler(fmt.CartridgeFormatError)
    @app.errorhandler(fmt.MetadataValidationError)
    @app.errorhandler(fmt.ColophonValidationError)
    def handle_store_error(exc: Exception):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": str(exc)}), 400
        return render_template("error.html", error=str(exc)), 400

    @app.errorhandler(413)
    def handle_too_large(exc: Exception):
        if request.path.startswith("/api/") or request.path.startswith("/setup/"):
            return jsonify({"ok": False, "error": "upload is too large"}), 413
        return render_template("error.html", error="Upload is too large."), 413

    @app.get("/")
    def index():
        q = request.args.get("q", "")
        return render_template(
            "index.html",
            games=store.list_games(q),
            q=q,
        )

    @app.get("/games/<game_id>")
    def game_detail(game_id: str):
        game = store.public_game(game_id, version=request.args.get("version"))
        scores = _scores_for_game(game_id)
        primary = get_setting("theme_primary_color", "#1a73e8")
        score_chart = _score_chart(scores, primary)
        download_stats = game_download_breakdown(game_id)
        return render_template(
            "game.html",
            game=game,
            scores=scores,
            score_chart=score_chart,
            download_count=download_stats["total"],
        )

    @app.get("/publish")
    @login_required
    def publish_page():
        return render_template(
            "publish.html",
            architectures=fmt.ARCHITECTURE_PROFILES,
            token=request.args.get("token", ""),
        )

    @app.post("/publish")
    @login_required
    def publish_page_post():
        result = publish_request(store)
        flash(f"Package uploaded for editor review as submission #{result['submission_id']}.")
        return redirect(url_for("publish_page"))

    @app.get("/setup")
    @admin_required
    def setup_page():
        return render_template("setup.html", settings=_settings_form_values())

    @app.post("/setup")
    @admin_required
    def setup_save():
        checkbox_keys = {
            "auth_allow_registration",
            "publish_require_auth",
            "mdns_enabled",
            "smtp_tls",
            "oidc_enabled",
            "saml_enabled",
        }
        for key in _settings_form_values():
            if key in checkbox_keys:
                set_setting(key, "true" if request.form.get(key) else "false")
            else:
                set_setting(key, request.form.get(key, DEFAULT_SETTINGS.get(key, "")))
        flash("Settings saved.")
        return redirect(url_for("setup_page"))

    @app.post("/setup/logo")
    @admin_required
    def setup_logo():
        return _save_custom_asset("logo", "theme_logo_url")

    @app.post("/setup/favicon")
    @admin_required
    def setup_favicon():
        return _save_custom_asset("favicon", "theme_favicon_url")

    @app.get("/static/custom/<filename>")
    def custom_static(filename: str):
        path = Path(app.config["DATA_DIR"]) / "static" / filename
        if not path.is_file() or "/" in filename or "\\" in filename:
            abort(404)
        return send_file(path)

    @app.get("/admin/users")
    @admin_required
    def admin_users():
        page = max(request.args.get("page", default=1, type=int), 1)
        per_page = 50
        rows = _admin_user_rows(per_page, (page - 1) * per_page)
        return render_template(
            "admin_users.html",
            users=rows,
            groups=_group_rows(),
            roles=ROLE_LEVELS,
            page=page,
        )

    @app.post("/admin/users")
    @admin_required
    def admin_user_create():
        username = request.form.get("username", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        role = request.form.get("role", "user")
        if role not in ROLE_LEVELS:
            return jsonify({"ok": False, "error": "unknown role"}), 400
        if not username or not email:
            return jsonify({"ok": False, "error": "username and email are required"}), 400
        db = get_db()
        cursor = db.execute(
            """
            INSERT INTO users(username, email, password_hash, role)
            VALUES (?, ?, ?, ?)
            """,
            (
                username,
                email,
                generate_password_hash(password or secrets.token_urlsafe(24)),
                role,
            ),
        )
        db.commit()
        _set_groups_from_form(int(cursor.lastrowid))
        return redirect(url_for("admin_users"))

    @app.post("/admin/users/<int:user_id>")
    @admin_required
    def admin_user_update(user_id: int):
        principal = current_principal()
        username = request.form.get("username", "").strip()
        email = request.form.get("email", "").strip().lower()
        role = request.form.get("role", "user")
        password = request.form.get("password", "")
        if role not in ROLE_LEVELS:
            return jsonify({"ok": False, "error": "unknown role"}), 400
        if user_id == principal.id and role != "admin":
            return jsonify({"ok": False, "error": "admins cannot demote themselves"}), 400
        if not username or not email:
            return jsonify({"ok": False, "error": "username and email are required"}), 400
        db = get_db()
        db.execute(
            "UPDATE users SET username = ?, email = ?, role = ? WHERE id = ?",
            (username, email, role, user_id),
        )
        if password:
            db.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (generate_password_hash(password), user_id),
            )
        db.commit()
        _set_groups_from_form(user_id)
        return redirect(url_for("admin_users"))

    @app.post("/admin/users/<int:user_id>/role")
    @admin_required
    def admin_user_role(user_id: int):
        principal = current_principal()
        role = request.form.get("role", "user")
        if user_id == principal.id:
            return jsonify({"ok": False, "error": "admins cannot demote themselves"}), 400
        if role not in ROLE_LEVELS:
            return jsonify({"ok": False, "error": "unknown role"}), 400
        _set_user_role(user_id, role)
        return redirect(url_for("admin_users"))

    @app.post("/admin/users/<int:user_id>/groups")
    @admin_required
    def admin_user_groups(user_id: int):
        _set_groups_from_form(user_id)
        return redirect(url_for("admin_users"))

    @app.delete("/admin/users/<int:user_id>")
    @app.post("/admin/users/<int:user_id>/delete")
    @admin_required
    def admin_user_delete(user_id: int):
        principal = current_principal()
        if user_id == principal.id:
            return jsonify({"ok": False, "error": "admins cannot delete themselves"}), 400
        deleted = _delete_user(user_id)
        if request.method == "DELETE":
            return jsonify({"ok": deleted})
        return redirect(url_for("admin_users"))

    @app.get("/admin/groups")
    @admin_required
    def admin_groups():
        return render_template("admin_groups.html", groups=_group_rows())

    @app.post("/admin/groups")
    @admin_required
    def admin_group_create():
        name = request.form.get("name", "").strip().lower()
        if not name:
            return jsonify({"ok": False, "error": "group name is required"}), 400
        get_db().execute("INSERT OR IGNORE INTO groups(name) VALUES (?)", (name,))
        get_db().commit()
        return redirect(url_for("admin_groups"))

    @app.post("/admin/groups/<int:group_id>")
    @admin_required
    def admin_group_update(group_id: int):
        name = request.form.get("name", "").strip().lower()
        if not name:
            return jsonify({"ok": False, "error": "group name is required"}), 400
        get_db().execute("UPDATE groups SET name = ? WHERE id = ?", (name, group_id))
        get_db().commit()
        return redirect(url_for("admin_groups"))

    @app.route("/admin/groups/<int:group_id>/delete", methods=["DELETE", "POST"])
    @admin_required
    def admin_group_delete(group_id: int):
        get_db().execute("DELETE FROM user_groups WHERE group_id = ?", (group_id,))
        cursor = get_db().execute("DELETE FROM groups WHERE id = ? AND name != 'editors'", (group_id,))
        get_db().commit()
        if request.method == "DELETE":
            return jsonify({"ok": cursor.rowcount > 0})
        return redirect(url_for("admin_groups"))

    @app.get("/admin/roles")
    @admin_required
    def admin_roles():
        return render_template("admin_roles.html", roles=_role_rows())

    @app.get("/admin/cartridges")
    def admin_cartridges():
        principal = current_principal()
        if not principal.authenticated:
            return redirect(url_for("auth_login", next=request.full_path))
        if principal.role != "admin" and "editors" not in principal.groups:
            return render_template("error.html", error="editors group required"), 403
        return render_template("admin_cartridges.html", games=store.list_games())

    @app.post("/admin/cartridges/<game_id>/<version>")
    def admin_cartridge_update(game_id: str, version: str):
        principal = current_principal()
        if not principal.authenticated:
            return redirect(url_for("auth_login", next=request.full_path))
        if principal.role != "admin" and "editors" not in principal.groups:
            return render_template("error.html", error="editors group required"), 403
        store.update_metadata(
            game_id,
            version,
            title=request.form.get("title", ""),
            summary=request.form.get("summary", ""),
            tags=split_csv(request.form.get("tags", "")),
        )
        return redirect(url_for("admin_cartridges"))

    @app.route("/admin/cartridges/<game_id>/<version>/delete", methods=["DELETE", "POST"])
    def admin_cartridge_delete(game_id: str, version: str):
        principal = current_principal()
        if not principal.authenticated:
            return redirect(url_for("auth_login", next=request.full_path))
        if principal.role != "admin" and "editors" not in principal.groups:
            return render_template("error.html", error="editors group required"), 403
        store.delete_variant(
            game_id,
            version,
            architecture=request.form.get("architecture") or request.args.get("architecture"),
        )
        if request.method == "DELETE":
            return jsonify({"ok": True})
        return redirect(url_for("admin_cartridges"))

    @app.get("/admin/backup")
    @admin_required
    def admin_backup_page():
        return render_template("admin_backup.html")

    @app.get("/admin/backup/download")
    @admin_required
    def admin_backup_download():
        archive = _create_backup_archive(store)
        return send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name="prg32-cartrige-store-backup.zip",
        )

    @app.post("/admin/backup/restore")
    @admin_required
    def admin_backup_restore():
        upload = request.files.get("backup")
        if upload is None or not upload.filename:
            return jsonify({"ok": False, "error": "backup file is required"}), 400
        _restore_backup_archive(store, upload.read())
        flash("Backup restored.")
        return redirect(url_for("admin_backup_page"))

    @app.get("/manifest.webmanifest")
    def manifest():
        return send_file(root / "static" / "manifest.webmanifest", mimetype="application/manifest+json")

    @app.get("/.well-known/prg32-store.json")
    def discovery():
        port = os.environ.get("PRG32_STORE_PORT")
        host = request.host
        if port:
            hostname = request.host.split(":", 1)[0]
            host = f"{hostname}:{port}"
        scheme = request.scheme
        base = f"{scheme}://{host}"
        ws_scheme = "wss" if request.scheme == "https" else "ws"
        ws_base = f"{ws_scheme}://{host}"
        return jsonify(
            {
                "abi": "prg32-store-discovery-1.0",
                "name": get_setting("store_name", app.config["STORE_NAME"]),
                "api": base + "/api",
                "web": base + "/",
                "version": app.config["STORE_VERSION"],
                "auth_enabled": auth_is_configured(),
                "roles": list(ROLE_LEVELS),
                "services": {
                    "cartridges": base + "/api/games",
                    "bundle_publish": base + "/api/publish/bundle",
                    "submissions": base + "/api/submissions",
                    "scores": base + "/api/scores",
                    "metrics": base + "/api/runs",
                    "multiplayer": ws_base + "/api/multiplayer",
                    "multiplayer_status": base + "/api/multiplayer/status",
                },
            }
        )

    @app.get("/api")
    def api_index():
        return jsonify(
            {
                "ok": True,
                "service": get_setting("store_name", app.config["STORE_NAME"]),
                "version": app.config["STORE_VERSION"],
                "auth_enabled": auth_is_configured(),
                "roles": list(ROLE_LEVELS),
                "mdns": {
                    "service": "_prg32store._tcp.local.",
                    "name": os.environ.get("PRG32_MDNS_NAME", app.config["STORE_NAME"]),
                },
                "endpoints": [
                    "GET /api/games",
                    "POST /api/publish",
                    "POST /api/publish/bundle",
                    "GET /api/submissions",
                    "GET /api/scores",
                    "POST /api/scores",
                    "GET /api/metrics",
                    "GET /api/runs",
                    "POST /api/runs",
                    "POST /api/metrics/batch",
                    "GET /api/multiplayer",
                    "GET /api/multiplayer/status",
                ],
            }
        )

    @app.get("/api/me")
    def api_me():
        return jsonify(
            {
                "ok": True,
                "auth_enabled": auth_is_configured(),
                "user": current_principal().as_dict(),
            }
        )

    @app.get("/api/games")
    def api_games():
        q = request.args.get("q") or request.args.get("search")
        return jsonify({"ok": True, "games": store.list_games(q)})

    @app.get("/api/games/<game_id>")
    def api_game(game_id: str):
        return jsonify({"ok": True, "game": store.public_game(game_id, version=request.args.get("version"))})

    @app.get("/api/games/<game_id>/icon")
    def api_icon(game_id: str):
        _, variant, parsed = store.parse_variant(
            game_id,
            version=request.args.get("version"),
            architecture=request.args.get("architecture"),
        )
        if parsed.icon is None:
            raise StoreError("icon not found")
        return Response(parsed.icon, mimetype=variant.get("icon_mime") or "image/png")

    @app.get("/api/games/<game_id>/screenshot")
    def api_screenshot(game_id: str):
        _, variant, parsed = store.parse_variant(
            game_id,
            version=request.args.get("version"),
            architecture=request.args.get("architecture"),
        )
        if parsed.screenshot is None:
            raise StoreError("screenshot not found")
        return Response(
            parsed.screenshot,
            mimetype=variant.get("screenshot_mime") or "image/png",
        )

    @app.get("/api/games/<game_id>/colophon")
    def api_colophon(game_id: str):
        _, _, parsed = store.parse_variant(
            game_id,
            version=request.args.get("version"),
            architecture=request.args.get("architecture"),
        )
        if parsed.colophon is None:
            raise StoreError("colophon not found")
        return jsonify({"ok": True, "colophon": parsed.colophon})

    @app.get("/api/games/<game_id>/download")
    def api_download(game_id: str):
        game, variant, path = store.resolve_variant(
            game_id,
            version=request.args.get("version"),
            architecture=request.args.get("architecture"),
        )
        record_download(game["id"], game["selected_version"], variant["architecture"])
        name = f"{game['id']}-{game['selected_version']}-{variant['architecture']}.prg32"
        return send_file(
            path,
            mimetype="application/vnd.prg32.cartridge",
            as_attachment=True,
            download_name=name,
        )

    @app.post("/api/publish")
    @login_required
    def api_publish():
        result = publish_request(store)
        result["legacy_endpoint"] = True
        return jsonify(result)

    @app.post("/api/publish/bundle")
    @login_required
    def api_publish_bundle():
        limit = int(app.config["BUNDLE_MAX_CONTENT_LENGTH"])
        if request.content_length is not None and request.content_length > limit:
            return jsonify({"ok": False, "error": "bundle upload is too large"}), 413
        result = publish_bundle_request(store)
        return jsonify(result)

    return app


def read_upload(name: str, *, required: bool) -> bytes | None:
    file = request.files.get(name)
    if file is None or not file.filename:
        if required:
            raise StoreError(f"missing upload: {name}")
        return None
    data = file.read()
    if required and not data:
        raise StoreError(f"empty upload: {name}")
    return data or None


def _settings_form_values() -> dict[str, str]:
    return {key: get_setting(key, default) for key, default in DEFAULT_SETTINGS.items()}


def _save_custom_asset(kind: str, setting_key: str):
    upload = request.files.get(kind)
    if upload is None or not upload.filename:
        return jsonify({"ok": False, "error": f"missing upload: {kind}"}), 400
    data = upload.read()
    if len(data) > 2 * 1024 * 1024:
        return jsonify({"ok": False, "error": f"{kind} is too large"}), 413
    ext = _asset_extension(data)
    if ext is None:
        return jsonify({"ok": False, "error": f"{kind} must be PNG, JPEG, or SVG"}), 400
    custom_dir = Path(current_app.config["DATA_DIR"]) / "static"
    custom_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{kind}.{ext}"
    (custom_dir / filename).write_bytes(data)
    url = url_for("custom_static", filename=filename)
    set_setting(setting_key, url)
    if request.accept_mimetypes.best == "application/json":
        return jsonify({"ok": True, "url": url})
    return redirect(url_for("setup_page"))


def _asset_extension(data: bytes) -> str | None:
    if fmt.detect_image_mime(data) == "image/png":
        return "png"
    if fmt.detect_image_mime(data) == "image/jpeg":
        return "jpg"
    stripped = data.lstrip()[:256].lower()
    if stripped.startswith(b"<svg") or stripped.startswith(b"<?xml"):
        return "svg"
    return None


def _admin_user_rows(limit: int, offset: int) -> list[dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT id, username, email, role, external_provider, created_at, last_login
        FROM users
        ORDER BY created_at ASC, id ASC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    ).fetchall()
    users = []
    for row in rows:
        user = dict(row)
        user["groups"] = groups_for_user(int(user["id"]))
        users.append(user)
    return users


def _set_user_role(user_id: int, role: str) -> None:
    get_db().execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
    get_db().commit()


def _delete_user(user_id: int) -> bool:
    cursor = get_db().execute("DELETE FROM users WHERE id = ?", (user_id,))
    get_db().commit()
    return cursor.rowcount > 0


def _set_groups_from_form(user_id: int) -> None:
    groups = request.form.getlist("groups")
    extra = request.form.get("extra_groups", "")
    groups.extend(split_csv(extra))
    set_user_groups(user_id, groups)


def _group_rows() -> list[dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT groups.id, groups.name, groups.created_at, COUNT(user_groups.user_id) AS user_count
        FROM groups
        LEFT JOIN user_groups ON user_groups.group_id = groups.id
        GROUP BY groups.id
        ORDER BY groups.name
        """
    ).fetchall()
    return [dict(row) for row in rows]


def _role_rows() -> list[dict[str, Any]]:
    rows = []
    for role, level in ROLE_LEVELS.items():
        count_row = get_db().execute(
            "SELECT COUNT(*) AS count FROM users WHERE role = ?",
            (role,),
        ).fetchone()
        rows.append({"name": role, "level": level, "user_count": int(count_row["count"])})
    return rows


def _create_backup_archive(store: GameStore) -> str:
    fd, archive_name = tempfile.mkstemp(prefix="prg32-store-backup-", suffix=".zip")
    os.close(fd)
    db = get_db()
    db.commit()
    source_db = Path(current_app.config["DATABASE"])
    data_dir = Path(current_app.config["DATA_DIR"])
    with tempfile.NamedTemporaryFile(prefix="prg32-store-db-", suffix=".sqlite", delete=False) as db_copy:
        copied_db = Path(db_copy.name)
    with sqlite3.connect(source_db) as source, sqlite3.connect(copied_db) as target:
        source.backup(target)
    try:
        with zipfile.ZipFile(archive_name, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "abi": "prg32-cartrige-store-backup-1.0",
                        "database": "database.sqlite",
                        "data_dir": "data/",
                    },
                    indent=2,
                    sort_keys=True,
                ),
            )
            archive.write(copied_db, "database.sqlite")
            for path in data_dir.rglob("*"):
                if path.is_file() and path.resolve() != source_db.resolve():
                    archive.write(path, "data/" + path.relative_to(data_dir).as_posix())
    finally:
        copied_db.unlink(missing_ok=True)
    return archive_name


def _restore_backup_archive(store: GameStore, data: bytes) -> None:
    data_dir = Path(current_app.config["DATA_DIR"])
    db_path = Path(current_app.config["DATABASE"])
    with tempfile.TemporaryDirectory(prefix="prg32-store-restore-") as tmp:
        tmp_path = Path(tmp)
        archive_path = tmp_path / "backup.zip"
        archive_path.write_bytes(data)
        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            if "database.sqlite" not in names:
                raise StoreError("backup is missing database.sqlite")
            _extract_backup(archive, tmp_path)
        restored_db = tmp_path / "database.sqlite"
        sqlite3.connect(restored_db).close()
        close_db()
        data_dir.mkdir(parents=True, exist_ok=True)
        for child in data_dir.iterdir():
            if child.resolve() == db_path.resolve():
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        restored_data = tmp_path / "data"
        if restored_data.is_dir():
            for child in restored_data.iterdir():
                target = data_dir / child.name
                if child.is_dir():
                    shutil.copytree(child, target, dirs_exist_ok=True)
                else:
                    shutil.copy2(child, target)
        shutil.copy2(restored_db, db_path)


def _extract_backup(archive: zipfile.ZipFile, destination: Path) -> None:
    root = destination.resolve()
    for member in archive.infolist():
        target = (destination / member.filename).resolve()
        if root != target and root not in target.parents:
            raise StoreError("backup contains an unsafe path")
        archive.extract(member, destination)


def _scores_for_game(game_id: str, limit: int = 20) -> list[dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT game, player, score, created_at, submitted_by
        FROM scores
        WHERE game = ?
        ORDER BY score DESC, created_at ASC
        LIMIT ?
        """,
        (game_id, limit),
    ).fetchall()
    return [dict(row) for row in rows]


def _score_chart(scores: list[dict[str, Any]], color: str) -> str:
    return charts.bar_chart(
        [(score["player"], int(score["score"])) for score in scores],
        color=color,
        title="Leaderboard",
    )


def parse_json_field(name: str) -> dict[str, Any] | None:
    raw = request.form.get(name, "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise StoreError(f"{name} must be valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise StoreError(f"{name} must be a JSON object")
    return parsed


def split_csv(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def metadata_from_form() -> dict[str, Any]:
    metadata = parse_json_field("metadata")
    if metadata is not None:
        return metadata
    author = request.form.get("author_name", "").strip()
    authors = [{"name": author}] if author else []
    if authors:
        email = request.form.get("author_email", "").strip()
        url = request.form.get("author_url", "").strip()
        if email:
            authors[0]["email"] = email
        if url:
            authors[0]["url"] = url
    runtime: dict[str, Any] = {"platform": "PRG32", "isa": "RV32I"}
    min_firmware = request.form.get("min_firmware", "").strip()
    if min_firmware:
        runtime["min_firmware"] = min_firmware
    return {
        "abi": fmt.METADATA_ABI,
        "id": request.form.get("id", "").strip(),
        "title": request.form.get("title", "").strip(),
        "version": request.form.get("version", "").strip(),
        "summary": request.form.get("summary", "").strip(),
        "description": request.form.get("description", "").strip(),
        "authors": authors,
        "license": request.form.get("license", "").strip(),
        "homepage": request.form.get("homepage", "").strip(),
        "repository": request.form.get("repository", "").strip(),
        "tags": split_csv(request.form.get("tags", "")),
        "runtime": runtime,
    }


def colophon_from_form(metadata: dict[str, Any]) -> dict[str, Any]:
    colophon = parse_json_field("colophon")
    if colophon is not None:
        return colophon
    developer_name = request.form.get("developer_name", "").strip()
    if not developer_name:
        raise StoreError("developer_name is required when colophon JSON is not provided")
    controls = []
    for raw in split_csv(request.form.get("controls", "")):
        if ":" in raw:
            input_name, action = raw.split(":", 1)
            controls.append({"input": input_name.strip(), "action": action.strip()})
    return {
        "abi": fmt.COLOPHON_ABI,
        "title": request.form.get("colophon_title", "").strip() or metadata.get("title", ""),
        "subtitle": request.form.get("subtitle", "").strip(),
        "version": request.form.get("colophon_version", "").strip() or metadata.get("version", ""),
        "release_date": request.form.get("release_date", "").strip(),
        "developer": {
            "name": developer_name,
            "url": request.form.get("developer_url", "").strip(),
        },
        "authors": [],
        "license": request.form.get("license", "").strip() or metadata.get("license", ""),
        "copyright": request.form.get("copyright", "").strip(),
        "acknowledgements": split_csv(request.form.get("acknowledgements", "")),
        "dedication": request.form.get("dedication", "").strip(),
        "content_notice": request.form.get("content_notice", "").strip(),
        "controls": controls,
        "start_prompt": request.form.get("start_prompt", "").strip() or "Press START to play",
    }


def publish_request(store: GameStore) -> dict[str, Any]:
    if request.files.get("bundle") is not None:
        return publish_bundle_request(store)
    raise StoreError("package upload required: upload a cartridge bundle (.zip)")


def publish_legacy_form_request(store: GameStore) -> dict[str, Any]:
    architecture = request.form.get("architecture", "esp32c6")
    legacy = read_upload("cartridge", required=True)
    icon = read_upload("icon", required=True)
    screenshot = read_upload("screenshot", required=False)
    signature = read_upload("signature", required=False)
    metadata = metadata_from_form()
    colophon = colophon_from_form(metadata)
    image = fmt.build_cartridge(
        legacy or b"",
        metadata=metadata,
        icon=icon or b"",
        screenshot=screenshot,
        signature=signature,
        colophon=colophon,
        architecture=architecture,
    )
    return publish_cartridge_image(store, image, architecture)


def publish_cartridge_image(store: GameStore, image: bytes, architecture: str) -> dict[str, Any]:
    parsed = fmt.parse_cartridge(image)
    return store.publish(
        image,
        parsed,
        architecture=fmt.normalize_architecture(architecture) or "esp32c6",
        publisher=current_principal().name,
    )


def publish_bundle_request(store: GameStore) -> dict[str, Any]:
    upload = request.files.get("bundle")
    if upload is None or not upload.filename:
        raise StoreError("missing upload: bundle")
    bundle = upload.read()
    if not bundle:
        raise StoreError("empty upload: bundle")
    if not bundle.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
        raise StoreError("bundle must be a zip file")
    try:
        with zipfile.ZipFile(BytesIO(bundle)) as zf:
            prepared = _prepare_bundle(zf)
    except zipfile.BadZipFile as exc:
        raise StoreError("bundle must be a valid zip file") from exc

    submission = create_submission(prepared)
    manifest = prepared[0]["manifest"]
    return {
        "status": "pending",
        "ok": True,
        "review_required": True,
        "submission_id": submission["id"],
        "id": manifest["id"],
        "version": manifest["version"],
        "submitted": [
            {"architecture": item["architecture"], "file": item["file"]}
            for item in prepared
        ],
    }


def _prepare_bundle(zf: zipfile.ZipFile) -> list[dict[str, Any]]:
    names = {info.filename for info in zf.infolist() if not info.is_dir()}
    if "manifest.json" not in names:
        raise StoreError("bundle is missing manifest.json")
    manifest = _read_manifest(zf)
    if manifest.get("abi") != fmt.METADATA_ABI:
        raise StoreError(f"manifest.abi must be {fmt.METADATA_ABI}")
    fmt.validate_metadata(manifest)
    assets = manifest.get("assets")
    if not isinstance(assets, dict):
        raise StoreError("manifest.assets must be an object")
    icon_name = _manifest_filename(assets.get("icon"), "manifest.assets.icon")
    if icon_name not in names:
        raise StoreError("bundle icon file is missing")
    icon = zf.read(icon_name)
    if fmt.detect_image_mime(icon) is None:
        raise StoreError("bundle icon must be PNG or JPEG")

    splash = None
    splash_name = assets.get("splash")
    if splash_name:
        splash_file = _manifest_filename(splash_name, "manifest.assets.splash")
        if splash_file not in names:
            raise StoreError("bundle splash file is missing")
        splash = zf.read(splash_file)
        if fmt.detect_image_mime(splash) is None:
            raise StoreError("bundle splash must be PNG or JPEG")

    architectures = manifest.get("architectures")
    if not isinstance(architectures, list) or not architectures:
        raise StoreError("manifest.architectures must be a non-empty array")

    prepared: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in architectures:
        if not isinstance(entry, dict):
            raise StoreError("manifest.architectures entries must be objects")
        architecture = fmt.normalize_architecture(str(entry.get("id", "")))
        if not architecture:
            raise StoreError("architecture id is required")
        if architecture in seen:
            raise StoreError(f"duplicate architecture: {architecture}")
        seen.add(architecture)
        file_name = _manifest_filename(entry.get("file"), "architecture.file")
        if not file_name.endswith(".prg32"):
            raise StoreError("architecture.file must point to a .prg32 file")
        if file_name not in names:
            raise StoreError(f"bundle cartridge file is missing: {file_name}")
        metadata = _bundle_metadata_for_cartridge(manifest)
        colophon = _bundle_colophon(manifest)
        image = fmt.build_cartridge(
            zf.read(file_name),
            metadata=metadata,
            icon=icon,
            screenshot=splash,
            colophon=colophon,
            architecture=architecture,
        )
        parsed = fmt.parse_cartridge(image)
        prepared.append(
            {
                "manifest": manifest,
                "architecture": architecture,
                "file": file_name,
                "image": image,
                "parsed": parsed,
            }
        )
    return prepared


def _read_manifest(zf: zipfile.ZipFile) -> dict[str, Any]:
    try:
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StoreError("manifest.json must be valid UTF-8 JSON") from exc
    if not isinstance(manifest, dict):
        raise StoreError("manifest.json must contain a JSON object")
    return manifest


def _manifest_filename(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StoreError(f"{label} is required")
    filename = value.strip()
    if filename.startswith("/") or ".." in Path(filename).parts:
        raise StoreError(f"{label} must be a relative filename")
    return filename


def _bundle_metadata_for_cartridge(manifest: dict[str, Any]) -> dict[str, Any]:
    metadata = deepcopy(manifest)
    metadata.pop("assets", None)
    metadata.pop("architectures", None)
    metadata.pop("colophon", None)
    return metadata


def _bundle_colophon(manifest: dict[str, Any]) -> dict[str, Any] | None:
    raw = manifest.get("colophon")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise StoreError("manifest.colophon must be an object")
    colophon = deepcopy(raw)
    colophon.setdefault("abi", fmt.COLOPHON_ABI)
    colophon.setdefault("title", manifest.get("title", ""))
    colophon.setdefault("version", manifest.get("version", ""))
    colophon.setdefault("subtitle", colophon.get("text", ""))
    if "developer" not in colophon:
        authors = manifest.get("authors") if isinstance(manifest.get("authors"), list) else []
        developer_name = "PRG32"
        if authors and isinstance(authors[0], dict) and authors[0].get("name"):
            developer_name = str(authors[0]["name"])
        colophon["developer"] = {"name": developer_name}
    colophon.setdefault("authors", colophon.get("credits", []))
    colophon.setdefault("controls", [])
    return colophon


def _publish_prepared_bundle(store: GameStore, prepared: list[dict[str, Any]]) -> None:
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
            publish_cartridge_image(store, item["image"], item["architecture"])
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


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=5080, debug=True)
