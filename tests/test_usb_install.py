"""Install over USB from a game page (PRG32 docs/software/web_usb_deployment.md).

Server side, with the Flask test client. The same page in a real browser is
tests/test_usb_install_browser.py.
"""

from __future__ import annotations

import hashlib
import io
import re
from pathlib import Path

from tests.test_api import bundle_bytes, client, verify_submission  # noqa: F401 - client is a fixture
from tests.test_prg32_format import colophon, metadata

ROOT = Path(__file__).resolve().parent.parent
CLIENT = (ROOT / "static/js/prg32_usb_protocol.js").read_text(encoding="utf-8")
CONTROLLER = (ROOT / "static/js/usb_install.js").read_text(encoding="utf-8")


def publish(client, game_id: str, architectures: list[str]) -> None:  # noqa: F811
    manifest = {
        **metadata(),
        "id": game_id,
        "title": "USB Game",
        "assets": {"icon": "icon.png"},
        "architectures": [{"id": arch, "file": f"game-{arch}.prg32"} for arch in architectures],
        "colophon": {**colophon(), "title": "USB Game"},
    }
    response = client.post(
        "/api/publish/bundle",
        data={"bundle": (io.BytesIO(bundle_bytes(manifest=manifest)), "bundle.zip")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    assert verify_submission(client, response.get_json()["submission_id"]).status_code == 200


def test_the_game_page_offers_usb_install_with_the_catalog_digest(client) -> None:  # noqa: F811
    publish(client, "org.example.usb", ["esp32c6", "qemu"])
    page = client.get("/games/org.example.usb").get_data(as_text=True)
    download = client.get("/api/games/org.example.usb/download?architecture=esp32c6").data
    assert 'id="usbInstall"' in page
    assert f'data-sha256="{hashlib.sha256(download).hexdigest()}"' in page
    assert f'data-size="{len(download)}"' in page
    assert '<script type="module" src="/static/js/usb_install.js"></script>' in page
    assert re.findall(r'<option value="(cart\d)">', page) == [f"cart{n}" for n in range(8)]
    assert 'value="debug"' not in page and 'value="performance"' not in page


def test_a_game_without_an_esp32c6_build_has_no_usb_install(client) -> None:  # noqa: F811
    publish(client, "org.example.qemuonly", ["qemu"])
    page = client.get("/games/org.example.qemuonly").get_data(as_text=True)
    assert 'id="usbInstall"' not in page


def test_module_scripts_from_the_store_are_allowed_and_nothing_else(client) -> None:  # noqa: F811
    policy = client.get("/").headers["Content-Security-Policy"]
    assert "script-src 'self';" in policy and "unsafe-inline" not in policy.split("script-src")[1].split(";")[0]


def test_the_service_worker_never_caches_api_answers_or_downloads() -> None:
    worker = (ROOT / "static/service-worker.js").read_text(encoding="utf-8")
    assert 'pathname.startsWith("/api/")' in worker
    assert worker.index('pathname.startsWith("/api/")') < worker.index("event.respondWith")


def test_the_usb_client_is_the_shared_copy_and_never_touches_reset_lines() -> None:
    kit_copy = ROOT.parent / "PRG32-Construction-Kit/static/js/prg32_usb_protocol.js"
    if kit_copy.exists():
        assert kit_copy.read_text(encoding="utf-8") == CLIENT
    assert "setSignals" not in CLIENT.split("export class ProtocolSession")[1]
    assert "setSignals" not in CONTROLLER
    assert "usbVendorId: 0x303a, usbProductId: 0x1001" in CLIENT
    assert "cartridgeProblems(info, capabilities, command)" in CONTROLLER
    assert "crypto.subtle.digest('SHA-256', data)" in CONTROLLER
