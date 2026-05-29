"""Filesystem storage for the PRG32 Cartrige Store."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any

from . import prg32_format as fmt


INDEX_ABI = "prg32-cartridge-store-index-1.0"
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
SAFE_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")


class StoreError(ValueError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _check_safe(value: str, pattern: re.Pattern[str], label: str) -> str:
    value = value.strip()
    if not pattern.fullmatch(value) or ".." in value:
        raise StoreError(f"invalid {label}: {value!r}")
    return value


def safe_game_id(game_id: str) -> str:
    return _check_safe(game_id, SAFE_ID_RE, "game id")


def safe_version(version: str) -> str:
    return _check_safe(version, SAFE_VERSION_RE, "version")


class GameStore:
    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir)
        self.cartridge_dir = self.data_dir / "cartridges"
        self.index_path = self.data_dir / "index.json"
        self.cartridge_dir.mkdir(parents=True, exist_ok=True)

    def _empty_index(self) -> dict[str, Any]:
        return {"abi": INDEX_ABI, "updated_at": utc_now(), "games": {}}

    def load_index(self) -> dict[str, Any]:
        if not self.index_path.exists():
            return self._empty_index()
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise StoreError(f"index is not valid JSON: {exc}") from exc
        if not isinstance(data, dict) or not isinstance(data.get("games"), dict):
            raise StoreError("index has an invalid shape")
        return data

    def save_index(self, index: dict[str, Any]) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        index["abi"] = INDEX_ABI
        index["updated_at"] = utc_now()
        tmp = self.index_path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        tmp.replace(self.index_path)

    def publish(
        self,
        image: bytes,
        parsed: fmt.CartridgeImage,
        *,
        architecture: str,
    ) -> dict[str, Any]:
        if parsed.metadata is None:
            raise StoreError("cartridge metadata trailer is missing META")
        if parsed.icon is None:
            raise StoreError("cartridge metadata trailer is missing ICON")
        metadata = parsed.metadata
        game_id = safe_game_id(metadata["id"])
        version = safe_version(metadata["version"])
        architecture = fmt.normalize_architecture(architecture) or "esp32c6"
        if metadata.get("runtime", {}).get("architecture") != architecture:
            raise StoreError("metadata.runtime.architecture does not match publish architecture")

        cart_path = self.cartridge_dir / game_id / version / f"{architecture}.prg32"
        cart_path.parent.mkdir(parents=True, exist_ok=True)
        cart_path.write_bytes(image)

        now = utc_now()
        sha256 = hashlib.sha256(image).hexdigest()
        index = self.load_index()
        games = index.setdefault("games", {})
        game = games.setdefault(
            game_id,
            {
                "id": game_id,
                "created_at": now,
                "versions": {},
            },
        )
        game.update(
            {
                "title": metadata["title"],
                "summary": metadata.get("summary", ""),
                "authors": metadata.get("authors", []),
                "tags": metadata.get("tags", []),
                "latest_version": version,
                "updated_at": now,
            }
        )
        versions = game.setdefault("versions", {})
        version_rec = versions.setdefault(
            version,
            {
                "version": version,
                "published_at": now,
                "architectures": {},
            },
        )
        version_rec.update(
            {
                "metadata": metadata,
                "colophon": parsed.colophon,
                "updated_at": now,
            }
        )
        rel = cart_path.relative_to(self.data_dir).as_posix()
        version_rec.setdefault("architectures", {})[architecture] = {
            "architecture": architecture,
            "filename": rel,
            "size": len(image),
            "sha256": sha256,
            "icon_mime": fmt.detect_image_mime(parsed.icon or b""),
            "screenshot_mime": fmt.detect_image_mime(parsed.screenshot or b"")
            if parsed.screenshot else None,
            "has_screenshot": parsed.screenshot is not None,
            "has_signature": parsed.signature is not None,
            "updated_at": now,
        }
        self.save_index(index)
        return self.public_game(game_id, version=version)

    def list_games(self, query: str | None = None) -> list[dict[str, Any]]:
        index = self.load_index()
        games = [self._public_game_record(game) for game in index.get("games", {}).values()]
        if query:
            needle = query.strip().lower()
            games = [game for game in games if self._matches_query(game, needle)]
        return sorted(games, key=lambda item: item["title"].lower())

    def public_game(self, game_id: str, version: str | None = None) -> dict[str, Any]:
        index = self.load_index()
        game = index.get("games", {}).get(safe_game_id(game_id))
        if not isinstance(game, dict):
            raise StoreError("game not found")
        return self._public_game_record(game, version)

    def _public_game_record(self, game: dict[str, Any], version: str | None = None) -> dict[str, Any]:
        versions = game.get("versions", {})
        selected_version = version or game.get("latest_version")
        if selected_version not in versions:
            raise StoreError("version not found")
        version_rec = versions[selected_version]
        architectures = version_rec.get("architectures", {})
        return {
            "id": game["id"],
            "title": game.get("title", game["id"]),
            "summary": game.get("summary", ""),
            "authors": game.get("authors", []),
            "tags": game.get("tags", []),
            "latest_version": game.get("latest_version"),
            "selected_version": selected_version,
            "versions": sorted(versions),
            "architectures": sorted(architectures),
            "metadata": version_rec.get("metadata"),
            "colophon": version_rec.get("colophon"),
            "variants": architectures,
            "updated_at": game.get("updated_at"),
        }

    def _matches_query(self, game: dict[str, Any], needle: str) -> bool:
        haystack = [
            game.get("id", ""),
            game.get("title", ""),
            game.get("summary", ""),
            " ".join(str(tag) for tag in game.get("tags", [])),
        ]
        for author in game.get("authors", []):
            if isinstance(author, dict):
                haystack.append(str(author.get("name", "")))
            else:
                haystack.append(str(author))
        return needle in " ".join(haystack).lower()

    def resolve_variant(
        self,
        game_id: str,
        *,
        version: str | None = None,
        architecture: str | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any], Path]:
        game = self.public_game(game_id, version=version)
        architectures = game["variants"]
        selected_arch = fmt.normalize_architecture(architecture) if architecture else None
        if selected_arch is None:
            selected_arch = "esp32c6" if "esp32c6" in architectures else sorted(architectures)[0]
        if selected_arch not in architectures:
            raise StoreError("architecture not found")
        variant = architectures[selected_arch]
        path = (self.data_dir / variant["filename"]).resolve()
        if self.data_dir.resolve() not in path.parents:
            raise StoreError("variant path escapes data directory")
        if not path.exists():
            raise StoreError("cartridge file is missing")
        return game, variant, path

    def parse_variant(
        self,
        game_id: str,
        *,
        version: str | None = None,
        architecture: str | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any], fmt.CartridgeImage]:
        game, variant, path = self.resolve_variant(
            game_id,
            version=version,
            architecture=architecture,
        )
        return game, variant, fmt.parse_cartridge(path.read_bytes())
