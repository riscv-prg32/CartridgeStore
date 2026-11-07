"""PRG32 firmware releases: list, cache, and serve them for flashing over USB.

The contract is PRG32 docs/usage/firmware_releases.md (manifest format
``prg32-firmware-release-1.0``) and docs/software/web_usb_deployment.md,
"Firmware flashing". The browser side is static/js/firmware_flash.js.

GitHub's release download servers send no CORS headers, so a page on this
Store cannot read them directly. The Store therefore:

1. asks the GitHub releases API which releases carry ``prg32-firmware.json``
   (answers are kept in memory for ``FIRMWARE_LIST_TTL`` seconds);
2. downloads a release's manifest and flash parts on first use into
   ``<DATA_DIR>/firmware/<tag>/``, checking every part against its SHA-256;
3. serves them from its own origin under ``/api/firmware/``.

An offline classroom can set ``PRG32_FIRMWARE_DIR`` to a folder with one
sub-folder per release (``v1.8.0/prg32-firmware.json`` plus its parts); the
Store then never contacts GitHub.

Only file names listed in a validated manifest are ever fetched or served, and
tags must look like release tags, so a request cannot reach other paths or
other hosts.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from flask import Flask, abort, current_app, jsonify, render_template, send_file

RELEASE_FORMAT = "prg32-firmware-release-1.0"
MANIFEST_NAME = "prg32-firmware.json"
DEFAULT_REPO = "riscv-prg32/PRG32"
USER_AGENT = "prg32-cartridge-store-firmware/1.0"
TAG_PATTERN = re.compile(r"^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$")
FILE_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]*\.bin$")
MAX_PART_BYTES = 4 * 1024 * 1024  # the ESP32-C6 flash is 4 MB
MAX_MANIFEST_BYTES = 256 * 1024
REQUIRED_ROLES = {"bootloader", "partition-table", "app"}

Fetcher = Callable[[str, str], bytes]


class FirmwareError(Exception):
    """A release that cannot be offered; shown to the user as a short message."""


def http_fetch(url: str, accept: str) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    token = os.environ.get("GITHUB_TOKEN", "")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    timeout = float(current_app.config.get("FIRMWARE_HTTP_TIMEOUT", 30))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https hosts
            return response.read(MAX_PART_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FirmwareError(f"GitHub could not be reached ({exc})") from exc


def validate_manifest(manifest: Any) -> dict:
    """Check the parts of the manifest this Store and the page rely on."""
    if not isinstance(manifest, dict) or manifest.get("format") != RELEASE_FORMAT:
        raise FirmwareError(f"not a {RELEASE_FORMAT} manifest")
    if manifest.get("chip") != "esp32c6":
        raise FirmwareError("the release is not for the ESP32-C6")
    profiles = manifest.get("profiles")
    if not isinstance(profiles, list) or not profiles:
        raise FirmwareError("the release lists no pin profiles")
    for profile in profiles:
        parts = profile.get("parts") if isinstance(profile, dict) else None
        if not isinstance(parts, list) or {part.get("role") for part in parts} != REQUIRED_ROLES:
            raise FirmwareError("a profile does not have bootloader, partition-table, and app parts")
        for part in parts:
            if not FILE_PATTERN.match(str(part.get("file", ""))):
                raise FirmwareError("a part has an unexpected file name")
            if not re.fullmatch(r"[0-9a-f]{64}", str(part.get("sha256", ""))):
                raise FirmwareError("a part has no SHA-256")
            offset = int(str(part.get("offset", "")), 0)
            if 0x9000 <= offset < 0x10000 or offset >= 0x210000:
                raise FirmwareError("a part would overwrite settings or cartridges")
            if not isinstance(part.get("size"), int) or not 0 < part["size"] <= MAX_PART_BYTES:
                raise FirmwareError("a part has an invalid size")
    return manifest


def summary(tag: str, release: dict, manifest: dict) -> dict:
    """The fields the firmware page needs to offer a release."""
    return {
        "tag": tag,
        "name": release.get("name") or tag,
        "published": release.get("published", ""),
        "prerelease": bool(release.get("prerelease")),
        "version": manifest.get("version", tag),
        "abi": manifest.get("abi", {}),
        "esp_idf": manifest.get("esp_idf", ""),
        "preserves": manifest.get("preserves", []),
        "profiles": [
            {key: profile[key] for key in ("name", "description", "warning") if key in profile}
            for profile in manifest["profiles"]
        ],
        "manifest_url": f"/api/firmware/releases/{tag}/{MANIFEST_NAME}",
    }


class FirmwareReleases:
    """Release list and on-disk cache. One instance per Flask app."""

    def __init__(self, cache_dir: Path, repo: str, local_dir: str, list_ttl: float,
                 fetcher: Fetcher | None = None) -> None:
        self.cache_dir = cache_dir
        self.repo = repo
        self.local_dir = Path(local_dir) if local_dir else None
        self.list_ttl = list_ttl
        self.fetcher = fetcher or http_fetch
        self.lock = threading.Lock()
        self.listed_at = 0.0
        self.listed: dict[str, dict] = {}

    # -- which releases exist -------------------------------------------------

    def releases(self) -> dict[str, dict]:
        """Tag -> {name, published, prerelease, assets: {file name: URL}}, newest first."""
        if self.local_dir is not None:
            found = {}
            for folder in sorted(self.local_dir.iterdir(), reverse=True) if self.local_dir.is_dir() else []:
                if TAG_PATTERN.match(folder.name) and (folder / MANIFEST_NAME).is_file():
                    found[folder.name] = {"name": folder.name, "published": "", "prerelease": False, "assets": {}}
            return found
        with self.lock:
            if self.listed and time.monotonic() - self.listed_at < self.list_ttl:
                return self.listed
        data = json.loads(self.fetcher(
            f"https://api.github.com/repos/{self.repo}/releases?per_page=30", "application/vnd.github+json"))
        found = {}
        for release in data if isinstance(data, list) else []:
            tag = str(release.get("tag_name", ""))
            assets = {asset.get("name"): asset.get("browser_download_url") for asset in release.get("assets", [])}
            if release.get("draft") or not TAG_PATTERN.match(tag) or MANIFEST_NAME not in assets:
                continue
            found[tag] = {
                "name": release.get("name") or tag,
                "published": str(release.get("published_at") or "")[:10],
                "prerelease": bool(release.get("prerelease")),
                "assets": assets,
            }
        with self.lock:
            self.listed, self.listed_at = found, time.monotonic()
        return found

    def release(self, tag: str) -> dict:
        if not TAG_PATTERN.match(tag):
            raise KeyError(tag)
        return self.releases()[tag]

    # -- the files of one release --------------------------------------------

    def folder(self, tag: str) -> Path:
        if self.local_dir is not None:
            return self.local_dir / tag
        return self.cache_dir / tag

    def manifest(self, tag: str) -> dict:
        release = self.release(tag)
        path = self.folder(tag) / MANIFEST_NAME
        if not path.is_file():
            data = self.fetcher(release["assets"][MANIFEST_NAME], "application/octet-stream")
            if len(data) > MAX_MANIFEST_BYTES:
                raise FirmwareError("the release manifest is too large")
            validate_manifest(json.loads(data))
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_bytes(data)
            temporary.replace(path)
        return validate_manifest(json.loads(path.read_text(encoding="utf-8")))

    def part(self, tag: str, name: str) -> Path:
        """A verified local copy of one flash part listed in the manifest."""
        manifest = self.manifest(tag)
        parts = {part["file"]: part for profile in manifest["profiles"] for part in profile["parts"]}
        if name not in parts:
            raise KeyError(name)
        part = parts[name]
        path = self.folder(tag) / name
        if path.is_file() and sha256_file(path) == part["sha256"]:
            return path
        if self.local_dir is not None:
            raise FirmwareError(f"{name} is missing or damaged in the local firmware folder")
        url = self.release(tag)["assets"].get(name)
        if not url:
            raise FirmwareError(f"the release has no {name}")
        data = self.fetcher(url, "application/octet-stream")
        if len(data) != part["size"] or hashlib.sha256(data).hexdigest() != part["sha256"]:
            raise FirmwareError(f"{name} does not match the release manifest")
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(data)
        temporary.replace(path)
        return path

    def summaries(self, include_prereleases: bool = True) -> list[dict]:
        offered = []
        for tag, release in self.releases().items():
            if release["prerelease"] and not include_prereleases:
                continue
            try:
                offered.append(summary(tag, release, self.manifest(tag)))
            except (FirmwareError, ValueError, KeyError):
                current_app.logger.warning("firmware release %s skipped: invalid manifest", tag)
        return offered


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def register_firmware_routes(app: Flask) -> None:
    releases = FirmwareReleases(
        cache_dir=Path(app.config["DATA_DIR"]) / "firmware",
        repo=app.config.get("FIRMWARE_REPO", DEFAULT_REPO),
        local_dir=app.config.get("FIRMWARE_DIR", ""),
        list_ttl=float(app.config.get("FIRMWARE_LIST_TTL", 600)),
        fetcher=app.config.get("FIRMWARE_FETCHER"),
    )
    app.extensions["prg32_firmware"] = releases

    @app.get("/firmware")
    def firmware_page():
        return render_template("firmware.html")

    @app.get("/api/firmware/releases")
    def firmware_release_list():
        try:
            return jsonify({"format": RELEASE_FORMAT, "repository": releases.repo,
                            "releases": releases.summaries()})
        except (FirmwareError, ValueError) as exc:
            return jsonify({"error": str(exc), "releases": []}), 502

    @app.get(f"/api/firmware/releases/<tag>/{MANIFEST_NAME}")
    def firmware_release_manifest(tag: str):
        try:
            return jsonify(releases.manifest(tag))
        except KeyError:
            abort(404)
        except (FirmwareError, ValueError) as exc:
            return jsonify({"error": str(exc)}), 502

    @app.get("/api/firmware/releases/<tag>/<name>")
    def firmware_release_part(tag: str, name: str):
        if not FILE_PATTERN.match(name):
            abort(404)
        try:
            path = releases.part(tag, name)
        except KeyError:
            abort(404)
        except (FirmwareError, ValueError) as exc:
            return jsonify({"error": str(exc)}), 502
        response = send_file(path, mimetype="application/octet-stream", max_age=86400)
        response.headers["X-Content-SHA256"] = sha256_file(path)
        return response
