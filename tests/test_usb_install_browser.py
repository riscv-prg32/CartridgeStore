"""Install over USB from a game page, in Chromium (PRG32 docs/software/web_usb_deployment.md).

Playwright cannot press the browser's own port chooser, so navigator.serial is
replaced by tests/js/fake_prg32_serial.js (shared with PRG32-Construction-Kit)
before the page loads. The page, usb_install.js, prg32_usb_protocol.js, the
download endpoint and the Content Security Policy are the real ones. These
tests skip when Playwright or a browser is not installed.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from cartridge_store import create_app
from tests.test_api import login_default_admin
from tests.test_usb_install import publish

ROOT = Path(__file__).resolve().parent.parent
FAKE = (ROOT / "tests/js/fake_prg32_serial.js").read_text(encoding="utf-8")

playwright_api = pytest.importorskip("playwright.sync_api", reason="Playwright is not installed")


@pytest.fixture(scope="module")
def live_store(tmp_path_factory):
    from werkzeug.serving import make_server

    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path_factory.mktemp("usb-store") / "data")})
    setup_client = app.test_client()
    login_default_admin(setup_client)
    publish(setup_client, "org.example.usb", ["esp32c6"])
    server = make_server("127.0.0.1", 0, app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    download = setup_client.get("/api/games/org.example.usb/download?architecture=esp32c6").data
    yield {"url": f"http://127.0.0.1:{server.server_port}", "cartridge": download}
    server.shutdown()


@pytest.fixture(scope="module")
def chromium():
    with playwright_api.sync_playwright() as playwright:
        browser = None
        for options in ({"channel": "chrome"}, {}):
            try:
                browser = playwright.chromium.launch(headless=True, **options)
                break
            except Exception:  # noqa: BLE001 - this browser is not installed: try the next
                continue
        if browser is None:
            pytest.skip("no Chrome or Playwright Chromium is installed")
        yield browser
        browser.close()


def game_page(chromium, live_store, **options):
    context = chromium.new_context()
    context.add_init_script(FAKE + f"\nwindow.__fakeSerial = installFakeSerial(navigator, {json.dumps(options)});")
    page = context.new_page()
    errors: list[str] = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto(f"{live_store['url']}/games/org.example.usb")
    return context, page, errors


def wait_for_status(page, kind: str) -> str:
    page.wait_for_selector(f"#usbStatus.{kind}", timeout=20000)
    return page.text_content("#usbStatus")


def test_a_visitor_installs_a_cartridge_over_usb(chromium, live_store) -> None:
    context, page, errors = game_page(chromium, live_store)
    assert page.is_disabled("#usbInstallStart")
    page.select_option("#usbSlot", "cart4")
    page.check("#usbConfirm")
    page.click("#usbInstallStart")
    assert wait_for_status(page, "ok") == "cart4 holds USB Game. The PRG32 is back in setup."
    stored = bytes(page.evaluate("Array.from(window.__fakeSerial.port.device.slots.cart4)"))
    assert stored == live_store["cartridge"]
    assert page.evaluate("window.__fakeSerial.requestPortFilters") == [{"usbVendorId": 0x303A, "usbProductId": 0x1001}]
    assert page.evaluate("window.__fakeSerial.port.device.setSignalsCalls") == 0
    assert page.evaluate("document.getElementById('usbProgress').value") == 100
    assert page.is_disabled("#usbInstallStart") and not page.is_checked("#usbConfirm")
    assert not [error for error in errors if "Content Security Policy" in error]
    context.close()


def test_run_starts_the_installed_cartridge(chromium, live_store) -> None:
    context, page, _errors = game_page(chromium, live_store, authorized=True)
    page.select_option("#usbCommand", "run")
    page.check("#usbConfirm")
    page.click("#usbInstallStart")
    assert wait_for_status(page, "ok") == "cart0 holds USB Game and it is running."
    context.close()


def test_a_cartridge_that_does_not_match_the_catalog_is_not_sent(chromium, live_store) -> None:
    context, page, _errors = game_page(chromium, live_store)
    page.evaluate("document.getElementById('usbInstall').dataset.sha256 = '00'.repeat(32)")
    page.check("#usbConfirm")
    page.click("#usbInstallStart")
    assert "does not match the catalog record" in wait_for_status(page, "error")
    assert page.evaluate("window.__fakeSerial.port.device.requests") == []
    context.close()


def test_a_console_with_another_abi_is_refused_before_writing(chromium, live_store) -> None:
    hello = {"runtime": {"cart_ram_size": 65536, "cart_max_size": 65536, "cart_abi_major": 2, "cart_abi_minor": 0}}
    context, page, _errors = game_page(chromium, live_store, hello=hello)
    page.check("#usbConfirm")
    page.click("#usbInstallStart")
    message = wait_for_status(page, "error")
    assert "this PRG32 runs ABI 2" in message and "Nothing was written." in message
    assert page.evaluate("window.__fakeSerial.port.device.requests") == [0x01]
    context.close()


def test_closing_the_chooser_writes_nothing(chromium, live_store) -> None:
    context, page, _errors = game_page(chromium, live_store, cancelChooser=True)
    page.check("#usbConfirm")
    page.click("#usbInstallStart")
    assert wait_for_status(page, "error") == "No USB device was selected; nothing was written."
    assert page.evaluate("window.__fakeSerial.port.device.opened") == 0
    context.close()


def test_a_browser_without_web_serial_is_told_why(chromium, live_store) -> None:
    context = chromium.new_context()
    context.add_init_script("Object.defineProperty(navigator, 'serial', { value: undefined, configurable: true });")
    page = context.new_page()
    page.goto(f"{live_store['url']}/games/org.example.usb")
    assert page.is_visible("#usbUnsupported")
    page.check("#usbConfirm")
    assert page.is_disabled("#usbInstallStart")
    context.close()
