"""Flask PWA for the PRG32 Cartrige Store."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    url_for,
)

from . import prg32_format as fmt
from .database import close_db
from .metrics import register_metrics_routes
from .multiplayer import register_multiplayer_routes
from .scores import register_score_routes
from .store import GameStore, StoreError


DEFAULT_MAX_UPLOAD = 8 * 1024 * 1024


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    root = Path(__file__).resolve().parents[1]
    data_dir = os.environ.get("PRG32_STORE_DATA", str(root / "data"))
    app = Flask(
        __name__,
        template_folder=str(root / "templates"),
        static_folder=str(root / "static"),
    )
    app.config.update(
        DATA_DIR=data_dir,
        DATABASE=os.environ.get(
            "PRG32_STORE_DB",
            os.environ.get(
                "PRG32_SCORE_DB",
                os.environ.get(
                    "PRG32_METRICS_DB",
                    str(Path(data_dir) / "cartrige_store.sqlite"),
                ),
            ),
        ),
        MAX_CONTENT_LENGTH=DEFAULT_MAX_UPLOAD,
        MULTIPLAYER_MAX_PEERS=int(os.environ.get("PRG32_MP_MAX_PEERS", "8")),
        STORE_NAME="PRG32 Cartrige Store",
        STORE_VERSION="1.0.0",
    )
    if test_config:
        app.config.update(test_config)
        if "DATABASE" not in test_config:
            app.config["DATABASE"] = str(
                Path(app.config["DATA_DIR"]) / "cartrige_store.sqlite"
            )

    store = GameStore(app.config["DATA_DIR"])
    app.teardown_appcontext(close_db)
    register_score_routes(app)
    register_metrics_routes(app)
    register_multiplayer_routes(app)

    @app.errorhandler(StoreError)
    @app.errorhandler(fmt.CartridgeFormatError)
    @app.errorhandler(fmt.MetadataValidationError)
    @app.errorhandler(fmt.ColophonValidationError)
    def handle_store_error(exc: Exception):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": str(exc)}), 400
        return render_template("error.html", error=str(exc)), 400

    @app.get("/")
    def index():
        q = request.args.get("q", "")
        return render_template(
            "index.html",
            games=store.list_games(q),
            q=q,
            store_name=app.config["STORE_NAME"],
        )

    @app.get("/games/<game_id>")
    def game_detail(game_id: str):
        game = store.public_game(game_id, version=request.args.get("version"))
        return render_template("game.html", game=game, store_name=app.config["STORE_NAME"])

    @app.route("/publish", methods=["GET", "POST"])
    def publish_page():
        if request.method == "POST":
            result = publish_request(store)
            return redirect(url_for("game_detail", game_id=result["id"]))
        return render_template(
            "publish.html",
            architectures=fmt.ARCHITECTURE_PROFILES,
            store_name=app.config["STORE_NAME"],
        )

    @app.get("/manifest.webmanifest")
    def manifest():
        return send_file(root / "static" / "manifest.webmanifest", mimetype="application/manifest+json")

    @app.get("/.well-known/prg32-store.json")
    def discovery():
        base = request.host_url.rstrip("/")
        ws_scheme = "wss" if request.scheme == "https" else "ws"
        ws_base = f"{ws_scheme}://{request.host}"
        return jsonify(
            {
                "abi": "prg32-store-discovery-1.0",
                "name": app.config["STORE_NAME"],
                "api": base + "/api",
                "web": base + "/",
                "version": app.config["STORE_VERSION"],
                "services": {
                    "cartridges": base + "/api/games",
                    "scores": base + "/api/scores",
                    "metrics": base + "/api/runs",
                    "multiplayer": ws_base + "/api/multiplayer",
                    "multiplayer_status": base + "/api/multiplayer/status",
                },
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
        name = f"{game['id']}-{game['selected_version']}-{variant['architecture']}.prg32"
        return send_file(
            path,
            mimetype="application/vnd.prg32.cartridge",
            as_attachment=True,
            download_name=name,
        )

    @app.post("/api/publish")
    def api_publish():
        return jsonify({"ok": True, "game": publish_request(store)})

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
    parsed = fmt.parse_cartridge(image)
    return store.publish(
        image,
        parsed,
        architecture=fmt.normalize_architecture(architecture) or "esp32c6",
    )


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=5080, debug=True)
