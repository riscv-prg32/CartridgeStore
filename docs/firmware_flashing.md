# Update the PRG32 Firmware over USB

The **Firmware** page (`/firmware`) writes an official PRG32 firmware release
onto an ESP32-C6 console connected to the visitor's computer, using the
browser's Web Serial API and Espressif's `esptool-js`. No ESP-IDF, PRG32 SDK
or command line is needed.

The release format and the rules every flashing host follows are in PRG32's
[Firmware Releases](https://github.com/riscv-prg32/PRG32/blob/main/docs/usage/firmware_releases.md)
(`prg32-firmware-release-1.0`); the web contract shared with the
PRG32-Construction-Kit is
[Web-to-USB deployment, "Firmware flashing"](https://github.com/riscv-prg32/PRG32/blob/main/docs/software/web_usb_deployment.md#firmware-flashing).
Installing a *cartridge* is a different page: [Install over USB](usb_install.md).

## For students and teachers

1. Connect the PRG32's **USB** connector (not **UART**) with a data cable.
2. Open **Firmware** in **Chrome** or **Edge**.
3. Choose a **release** (newest first) and the **pin profile** that matches how
   the console is wired (`breadboard1`, `breadboard2`, `pcb1`; see PRG32's
   [pin profiles](https://github.com/riscv-prg32/PRG32/blob/main/docs/hardware/profiles/README.md)).
4. Tick **The pin profile matches how this console is wired**.
5. Press **Connect and write the firmware** and pick the board in the
   browser's window. The page restarts the chip into its bootloader, writes
   the bootloader, the partition table and the firmware, and restarts it.

The console keeps its Wi-Fi settings, joystick calibration, the cartridges in
its eight slots and its scores. **Full erase** (folded away under the button)
deletes all of them first; the page asks again before doing it.

`pcb1` wires the joystick to GPIO13, which is USB D+: after a `pcb1` firmware
starts, the USB port stops answering. The page shows that warning and asks for
confirmation. If a breadboard console was given `pcb1` by mistake, hold BOOT,
press RESET, and flash the right profile.

If the screen stays dark after writing, press RESET once.

## For administrators

- **HTTPS is required**, as for [Install over USB](usb_install.md#for-administrators).
- **Where the files come from.** GitHub release downloads cannot be read by a
  page on another site (they send no CORS headers), so the Store fetches them:
  it lists `https://api.github.com/repos/riscv-prg32/PRG32/releases` (kept
  for `PRG32_FIRMWARE_LIST_TTL` seconds, default 600), and on first use
  downloads a release's `prg32-firmware.json` and parts into
  `<PRG32_STORE_DATA>/firmware/<tag>/`, checking each part's size and SHA-256.
  The page checks them again before writing.
- **Offline classrooms.** Set `PRG32_FIRMWARE_DIR` to a folder holding one
  sub-folder per release (for example `v1.8.0/`, with `prg32-firmware.json`
  and the `.bin` parts from that release). The Store then lists only those
  releases and never contacts GitHub.
- `PRG32_FIRMWARE_REPO` selects another repository (`owner/name`, default
  `riscv-prg32/PRG32`), for example a course fork. `GITHUB_TOKEN`, when set,
  is sent to the GitHub API only, to raise the anonymous limit of 60 requests
  per hour.
- **What is refused.** Releases whose tag is not a version, manifests in
  another format or for another chip, profiles without the three parts, parts
  that would land in the settings (0x9000-0xffff) or cartridge area
  (0x210000 and above), and any file not named in the manifest.
- **Privacy.** The page records nothing about the visitor or the console.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRG32_FIRMWARE_REPO` | `riscv-prg32/PRG32` | GitHub repository whose releases are offered |
| `PRG32_FIRMWARE_DIR` | empty | Local folder of releases; disables GitHub |
| `PRG32_FIRMWARE_LIST_TTL` | `600` | Seconds the release list is kept |
| `GITHUB_TOKEN` | empty | Optional GitHub API token |

## For developers

- Server: `cartridge_store/firmware.py`. Page: `templates/firmware.html` and
  `static/js/firmware_flash.js`.
- `static/vendor/esptool-js/esptool-0.6.1.js` is the unmodified `bundle.js`
  of the npm package `esptool-js@0.6.1` (Apache-2.0, `LICENSE` beside it),
  SHA-256 `ef7d5a237d3f273ecf546bcee65dddad90bd82cf02f22a980d1537e0cd79a152`.
  It is served by the Store, so the Content Security Policy keeps
  `script-src 'self'`. To update it, replace the file with the `bundle.js` of
  a newer release, rename it with that version, and change the import in
  `firmware_flash.js`.
- `esptool-js` performs the reset into the bootloader and back; page code never
  sets DTR or RTS itself.
- Tests: `tests/test_firmware.py` (fake GitHub, no network).

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/firmware/releases` | Releases with a valid manifest: tag, name, published date, version, ABI, profiles (name, description, warning), `manifest_url` |
| `GET` | `/api/firmware/releases/<tag>/prg32-firmware.json` | The release manifest |
| `GET` | `/api/firmware/releases/<tag>/<file>.bin` | One flash part named in the manifest, with `X-Content-SHA256` |

Errors reaching GitHub or invalid releases answer `502` with `{"error": ...}`;
unknown tags and files answer `404`.

## Validation record

- 2026-11-07: `tests/test_firmware.py` passes. Against the real
  `riscv-prg32/PRG32` release `v1.8.0`, the page listed the release and its
  three profiles, showed the `pcb1` warning, and downloaded and verified all
  nine parts from the Store's origin in the browser. Writing to a board from
  the page was not tested here: Chrome's port chooser needs a person.
