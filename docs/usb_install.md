# Install a Cartridge on a PRG32 over USB

Every game page with an `esp32c6` build has an **Install on a PRG32 over USB**
panel. It copies the published cartridge from the Store straight onto a
console connected to the visitor's computer, using the browser's Web Serial
API. No Wi-Fi, firmware update or command line is needed.

The technical contract shared with the PRG32 firmware and the
PRG32-Construction-Kit is PRG32's
[Web-to-USB cartridge deployment](https://github.com/riscv-prg32/PRG32/blob/development-c6/docs/software/web_usb_deployment.md);
the wire format is its
[device protocol](https://github.com/riscv-prg32/PRG32/blob/development-c6/docs/software/usb_protocol.md).

## For students and teachers

1. Connect the PRG32's **USB** connector (not **UART**) to the computer with a
   data cable. The console must be switched on and running PRG32 firmware from
   October 2026 or newer.
2. Open the game page in **Chrome** or **Edge**.
3. Choose a slot (`cart0` to `cart7`) and whether the PRG32 should **store** the
   cartridge and return to setup, or **run** it at once.
4. Tick **Replace what is in this slot**. The console erases that slot when
   the transfer starts.
5. Press **Connect and install over USB** and pick the PRG32 in the browser's
   window. The browser lists only ESP32-C6 USB devices, and remembers the one
   you allowed.

The console shows the cartridge name, the slot and a progress bar. A 22 KB
cartridge takes about two seconds. The page reports
`cart4 holds <game>. The PRG32 is back in setup.` or
`… and it is running.`

| The page says | What to do |
| --- | --- |
| This browser cannot reach USB devices | use Chrome or Edge, over HTTPS or as `localhost` |
| No USB device was selected; nothing was written | press the button again and choose the PRG32 |
| The USB port is busy | close serial monitors and the PRG32 command line, then try again |
| The PRG32 device did not answer | check the cable is a data cable on the **USB** connector and the console runs PRG32 firmware |
| … this PRG32 runs ABI … Nothing was written | the console's firmware is from another PRG32 version; ask your teacher |
| … accepts at most … bytes | this cartridge is too large for that console's firmware |
| does not match the catalog record | reload the page; the cartridge changed or the download was damaged |

If the cable is pulled during a transfer, the console shows UPLOAD TIMED OUT
within ten seconds, erases the half-written slot and returns to setup.

## For administrators

- **HTTPS is required.** Browsers expose Web Serial only on `https://` pages
  and on `http://localhost`. A Store reached as `http://192.168.x.y:5080`
  shows the panel with an explanation instead of the button. Put the Store
  behind HTTPS as described in [Deployment](deployment.md).
- **What is checked before anything is written:** the download's SHA-256 and
  size against the catalog record (`game.variants.esp32c6.sha256`, `.size`),
  the `PRG2` header, and the console's protocol, cartridge ABI major version
  and maximum cartridge size from its HELLO answer. The console then checks the
  CRC of every chunk and validates the stored cartridge.
- **Statistics:** the panel downloads through the normal
  `GET /api/games/<id>/download` endpoint, so each installation counts as one
  download; nothing else is recorded.
- **Offline cache:** the service worker never caches `/api/` answers, so a
  stale cartridge cannot be installed from the cache.
- **No CDN:** the page loads `static/js/usb_install.js` and
  `static/js/prg32_usb_protocol.js` from the Store under the existing
  `script-src 'self'` policy.

`static/js/prg32_usb_protocol.js` is a byte-identical copy of the
PRG32-Construction-Kit client; change it there and in the Store together.
`tests/test_usb_install.py` compares the two when both repositories are checked
out side by side.

## Tests

- `tests/test_usb_install.py`: the game page offers USB install only for
  `esp32c6` builds, carries the catalog digest and size, offers only `store`
  and `run`, the policy allows the module scripts, and the service worker
  bypasses `/api/`.
- `tests/test_usb_install_browser.py`: the real game page in Chromium with a
  pretend PRG32 (`tests/js/fake_prg32_serial.js`): installing and running,
  refusing a tampered download and a console with another ABI before writing,
  a closed chooser, and a browser without Web Serial. It skips when Playwright
  is not installed (`pip install playwright && playwright install chromium`).

Recorded on 2026-10-29: the DeviceDemo store bundle was published to a
throwaway Store, downloaded as its `esp32c6` variant (21,931 bytes, digest
matching the catalog), and installed with `run` into `cart6` of a physical
ESP32-C6 prototype by the same client module, through PRG32-Construction-Kit's
`tools/usb_device_check.mjs`: 8/8 checks passed in 1.67 s. A person-picked
Web Serial session in a desktop browser on that console has not been recorded.
