"""PRG32 firmware releases at /firmware (docs/firmware_flashing.md).

GitHub is replaced by an in-memory fake, so these tests need no network.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from cartridge_store import create_app

ROOT = Path(__file__).resolve().parent.parent
CONTROLLER = (ROOT / "static/js/firmware_flash.js").read_text(encoding="utf-8")
API = "https://api.github.com/repos/riscv-prg32/PRG32/releases?per_page=30"
DOWNLOAD = "https://github.com/riscv-prg32/PRG32/releases/download/v1.8.0/"


def release_files(tag: str = "v1.8.0") -> dict[str, bytes]:
    parts = {
        "bootloader": ("0x0", b"boot" * 10),
        "partition-table": ("0x8000", b"table" * 10),
        "app": ("0x10000", b"app" * 100),
    }
    files = {}
    profiles = []
    for profile in ("breadboard1", "pcb1"):
        entries = []
        for role, (offset, data) in parts.items():
            name = f"prg32-firmware-{tag}-esp32c6-{profile}-{role}.bin"
            files[name] = data + profile.encode()
            entries.append({"role": role, "offset": offset, "file": name, "size": len(files[name]),
                            "sha256": hashlib.sha256(files[name]).hexdigest()})
        entry = {"name": profile, "description": f"{profile} wiring", "parts": entries}
        if profile == "pcb1":
            entry["warning"] = "pcb1 uses GPIO13"
        profiles.append(entry)
    manifest = {
        "format": "prg32-firmware-release-1.0", "version": tag, "chip": "esp32c6",
        "abi": {"major": 1, "minor": 8, "hash": "0x71b93e23"},
        "flash": {"flash_mode": "dio", "flash_size": "4MB", "flash_freq": "80m"},
        "preserves": ["nvs", "cart0", "cart7", "scores"], "profiles": profiles,
    }
    files["prg32-firmware.json"] = json.dumps(manifest).encode()
    return files


class FakeGitHub:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.calls: list[str] = []
        self.listing = [
            {"tag_name": "v1.8.0", "name": "PRG32 firmware v1.8.0", "published_at": "2026-11-07T09:00:00Z",
             "draft": False, "prerelease": False,
             "assets": [{"name": name, "browser_download_url": DOWNLOAD + name} for name in files]},
            {"tag_name": "v0.9.0", "name": "No manifest", "draft": False, "prerelease": False,
             "assets": [{"name": "PRG32.bin", "browser_download_url": "https://example.invalid/x"}]},
            {"tag_name": "../../etc", "name": "Bad tag", "draft": False, "prerelease": False,
             "assets": [{"name": "prg32-firmware.json", "browser_download_url": "https://example.invalid/y"}]},
        ]

    def __call__(self, url: str, accept: str) -> bytes:
        self.calls.append(url)
        if url == API:
            return json.dumps(self.listing).encode()
        if url.startswith(DOWNLOAD):
            return self.files[url[len(DOWNLOAD):]]
        raise AssertionError(f"unexpected fetch {url}")


@pytest.fixture()
def github() -> FakeGitHub:
    return FakeGitHub(release_files())


@pytest.fixture()
def client(tmp_path, github):
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "FIRMWARE_FETCHER": github})
    return app.test_client()


def test_only_releases_with_a_valid_manifest_and_tag_are_offered(client, github) -> None:
    answer = client.get("/api/firmware/releases").get_json()
    assert [release["tag"] for release in answer["releases"]] == ["v1.8.0"]
    release = answer["releases"][0]
    assert release["abi"]["minor"] == 8
    assert [profile["name"] for profile in release["profiles"]] == ["breadboard1", "pcb1"]
    assert release["profiles"][1]["warning"] == "pcb1 uses GPIO13"
    assert release["manifest_url"] == "/api/firmware/releases/v1.8.0/prg32-firmware.json"
    assert not any("example.invalid" in call for call in github.calls)


def test_the_list_is_cached_and_parts_are_downloaded_once(client, github) -> None:
    client.get("/api/firmware/releases")
    client.get("/api/firmware/releases")
    assert github.calls.count(API) == 1
    name = "prg32-firmware-v1.8.0-esp32c6-breadboard1-app.bin"
    first = client.get(f"/api/firmware/releases/v1.8.0/{name}")
    second = client.get(f"/api/firmware/releases/v1.8.0/{name}")
    assert first.status_code == second.status_code == 200
    assert first.data == github.files[name]
    assert first.headers["X-Content-SHA256"] == hashlib.sha256(github.files[name]).hexdigest()
    assert github.calls.count(DOWNLOAD + name) == 1


def test_a_damaged_part_is_refused_and_not_kept(client, github) -> None:
    name = "prg32-firmware-v1.8.0-esp32c6-pcb1-app.bin"
    github.files[name] = b"tampered"
    response = client.get(f"/api/firmware/releases/v1.8.0/{name}")
    assert response.status_code == 502
    assert "does not match" in response.get_json()["error"]


def test_only_files_named_in_the_manifest_are_served(client) -> None:
    assert client.get("/api/firmware/releases/v1.8.0/PRG32.bin").status_code == 404
    assert client.get("/api/firmware/releases/v1.8.0/..%2Fsecret.bin").status_code == 404
    assert client.get("/api/firmware/releases/notatag/prg32-firmware.json").status_code == 404
    assert client.get("/api/firmware/releases/v2.0.0/prg32-firmware.json").status_code == 404


def test_a_manifest_that_would_overwrite_settings_is_rejected(tmp_path) -> None:
    files = release_files()
    manifest = json.loads(files["prg32-firmware.json"])
    manifest["profiles"][0]["parts"][1]["offset"] = "0x9000"
    files["prg32-firmware.json"] = json.dumps(manifest).encode()
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "FIRMWARE_FETCHER": FakeGitHub(files)})
    assert app.test_client().get("/api/firmware/releases").get_json()["releases"] == []


def test_a_local_firmware_folder_needs_no_network(tmp_path) -> None:
    folder = tmp_path / "firmware" / "v1.8.0"
    folder.mkdir(parents=True)
    for name, data in release_files().items():
        (folder / name).write_bytes(data)

    def no_network(url: str, accept: str) -> bytes:
        raise AssertionError("the local folder must be used")

    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data"),
                      "FIRMWARE_DIR": str(tmp_path / "firmware"), "FIRMWARE_FETCHER": no_network})
    client = app.test_client()
    assert [r["tag"] for r in client.get("/api/firmware/releases").get_json()["releases"]] == ["v1.8.0"]
    name = "prg32-firmware-v1.8.0-esp32c6-breadboard1-bootloader.bin"
    assert client.get(f"/api/firmware/releases/v1.8.0/{name}").status_code == 200


def test_github_unreachable_gives_a_readable_error(tmp_path) -> None:
    from cartridge_store.firmware import FirmwareError

    def offline(url: str, accept: str) -> bytes:
        raise FirmwareError("GitHub could not be reached (offline)")

    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "FIRMWARE_FETCHER": offline})
    response = app.test_client().get("/api/firmware/releases")
    assert response.status_code == 502
    assert "could not be reached" in response.get_json()["error"]


def test_the_page_loads_the_vendored_flasher_from_the_store(client) -> None:
    page = client.get("/firmware").get_data(as_text=True)
    assert 'id="firmwareFlash"' in page
    assert '<script type="module" src="/static/js/firmware_flash.js"></script>' in page
    assert 'href="/firmware"' in client.get("/").get_data(as_text=True)
    vendored = ROOT / "static/vendor/esptool-js/esptool-0.6.1.js"
    assert vendored.is_file() and (vendored.parent / "LICENSE").is_file()
    assert "from '/static/vendor/esptool-js/esptool-0.6.1.js'" in CONTROLLER


def test_the_page_checks_digests_keeps_settings_and_never_touches_reset_lines() -> None:
    assert "crypto.subtle.digest('SHA-256', data)" in CONTROLLER
    assert "eraseAll: false" in CONTROLLER
    assert "setDTR" not in CONTROLLER and "setRTS" not in CONTROLLER and "setSignals" not in CONTROLLER
    assert "usbVendorId: 0x303a, usbProductId: 0x1001" in CONTROLLER
    assert "fetch('https://" not in CONTROLLER and "github.com/riscv-prg32/PRG32/releases/download" not in CONTROLLER
