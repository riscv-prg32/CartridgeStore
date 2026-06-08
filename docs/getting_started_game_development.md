# Getting Started With PRG32 Game Development

This guide walks through a complete cartridge development path:

1. Install host tools on Windows, Linux, or macOS.
2. Prepare either PlatformIO or ESP-IDF.
3. Create a `hello-world` cartridge from an empty working directory.
4. Build and run it in QEMU.
5. Build and upload it to an ESP32-C6 PRG32 device.
6. Create a Cartridge Store publishing package.
7. Upload the package to PRG32 Cartridge Store.

The Store accepts `.zip` publishing packages containing one or more `.prg32`
cartridge files. Building and running those cartridge files requires the PRG32
firmware/game SDK used in your course or lab. The command names below use
`prg32-cart`, `prg32-qemu`, and `prg32-upload` as readable examples. If your
SDK names those tools differently, keep the same workflow and substitute the
matching SDK commands.

## What You Need

Hardware:

- A PRG32 ESP32-C6 board for physical upload.
- A USB data cable.
- Optional: a classroom Cartridge Store running at `http://127.0.0.1:5080` or
  a LAN URL.

Common software:

- Git.
- Python 3.11 or newer.
- A C/C++ build toolchain.
- CMake and Ninja.
- `zip`, `unzip`, and `curl`.
- QEMU for the emulator path.
- USB serial permissions or drivers for the hardware path.
- The PRG32 firmware/game SDK checkout.

Choose one firmware environment:

- PlatformIO: easiest if you already use VS Code or want one command to install
  board toolchains.
- ESP-IDF: best when contributing to firmware, changing board support, or
  debugging lower-level ESP32-C6 behavior.

## Platform Notes

### Windows 10/11

Use PowerShell. Install base tools:

```powershell
winget install --id Git.Git -e
winget install --id Python.Python.3.13 -e
winget install --id Kitware.CMake -e
winget install --id Ninja-build.Ninja -e
```

Close and reopen PowerShell, then verify:

```powershell
git --version
python --version
cmake --version
ninja --version
```

Install PlatformIO:

```powershell
python -m pip install --user --upgrade pip platformio
pio --version
```

For ESP-IDF, use Espressif's Windows installer or the ESP-IDF VS Code
extension. Open the "ESP-IDF Command Prompt" installed by Espressif before
running `idf.py`.

USB notes:

- The PRG32 board usually appears as `COM3`, `COM4`, or similar.
- Check Device Manager if upload cannot find the port.
- Use `pio device list` or `python -m serial.tools.list_ports`.

### Linux

Install base tools on Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y \
  git python3 python3-venv python3-pip \
  build-essential cmake ninja-build ccache \
  curl zip unzip qemu-system-misc \
  libffi-dev libssl-dev libusb-1.0-0 dfu-util
```

Add your user to the serial-port group:

```bash
sudo usermod -aG dialout "$USER"
```

Log out and back in, then verify:

```bash
git --version
python3 --version
cmake --version
ninja --version
qemu-system-riscv32 --version || qemu-system-xtensa --version
```

Install PlatformIO:

```bash
python3 -m pip install --user --upgrade pip platformio
python3 -m platformio --version
```

For ESP-IDF:

```bash
mkdir -p "$HOME/esp"
cd "$HOME/esp"
git clone --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh esp32c6 esp32c3
. ./export.sh
idf.py --version
```

### macOS

Install Xcode command line tools and Homebrew packages:

```bash
xcode-select --install
brew install git python cmake ninja ccache curl zip unzip qemu dfu-util libusb
```

Verify:

```bash
git --version
python3 --version
cmake --version
ninja --version
qemu-system-riscv32 --version || qemu-system-xtensa --version
```

Install PlatformIO:

```bash
python3 -m pip install --user --upgrade pip platformio
python3 -m platformio --version
```

For ESP-IDF:

```bash
mkdir -p "$HOME/esp"
cd "$HOME/esp"
git clone --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh esp32c6 esp32c3
. ./export.sh
idf.py --version
```

USB notes:

- Hardware usually appears as `/dev/cu.usbmodem*` or `/dev/cu.usbserial*`.
- Use `ls /dev/cu.*` before and after plugging in the board.

## Prepare The PRG32 SDK

Clone the firmware/game SDK used by your class. Keep it separate from your
games:

```bash
mkdir -p "$HOME/prg32"
cd "$HOME/prg32"
git clone https://github.com/riscv-prg32/FairWindSK.git prg32-sdk
cd prg32-sdk
```

If your course uses a different SDK repository, clone that repository instead.
The important outcome is that these commands, or their local equivalents, work:

```bash
prg32-cart --help
prg32-qemu --help
prg32-upload --help
```

If your SDK exposes Make, CMake, PlatformIO, or `idf.py` targets instead of
standalone commands, define shell aliases so the rest of the guide stays easy
to follow:

```bash
alias prg32-cart="$HOME/prg32/prg32-sdk/tools/prg32-cart"
alias prg32-qemu="$HOME/prg32/prg32-sdk/tools/prg32-qemu"
alias prg32-upload="$HOME/prg32/prg32-sdk/tools/prg32-upload"
```

On Windows PowerShell, prefer full paths or create small `.ps1` wrappers.

## Create The Working Directory

Start from an empty directory:

```bash
mkdir -p "$HOME/prg32-games/hello-world"
cd "$HOME/prg32-games/hello-world"
mkdir -p src assets build dist
git init
```

Create `src/main.c`:

```c
#include <stdint.h>
#include "prg32_game.h"

static int frame;

void prg32_init(void) {
    frame = 0;
}

void prg32_update(void) {
    frame++;
}

void prg32_draw(void) {
    prg32_clear(0x000000);
    prg32_text(16, 24, "Hello, PRG32!", 0xffffff);
    prg32_text(16, 40, "START exits demo", 0x88ccff);
    prg32_text_i32(16, 56, "Frame: ", frame, 0xcccccc);
}
```

If your SDK uses different entry points or drawing functions, create the same
behavior with the SDK's template project. The important result is a program
that draws text every frame and can be linked as a PRG32 cartridge.

Create `assets/icon.png` with a tiny generated image:

```bash
python3 -m pip install --user pillow
python3 - <<'PY'
from PIL import Image, ImageDraw

image = Image.new("RGB", (64, 64), "#003c78")
draw = ImageDraw.Draw(image)
draw.rectangle((8, 8, 55, 55), outline="#ffffff", width=4)
draw.text((18, 24), "32", fill="#ffffff")
image.save("assets/icon.png")
PY
```

## Build With PlatformIO

Create `platformio.ini`:

```ini
[platformio]
default_envs = qemu

[env]
framework = espidf
monitor_speed = 115200
build_flags =
  -DPRG32_GAME=1
  -Iinclude

[env:qemu]
platform = espressif32
board = esp32-c3-devkitm-1
build_flags =
  ${env.build_flags}
  -DPRG32_TARGET_QEMU=1

[env:esp32c6]
platform = espressif32
board = esp32-c6-devkitc-1
build_flags =
  ${env.build_flags}
  -DPRG32_TARGET_ESP32C6=1
```

Build QEMU and hardware variants:

```bash
pio run -e qemu
pio run -e esp32c6
```

Convert the built firmware payloads to `.prg32` cartridges:

```bash
prg32-cart build \
  --architecture qemu \
  --input .pio/build/qemu/firmware.bin \
  --output build/hello-qemu.prg32

prg32-cart build \
  --architecture esp32c6 \
  --input .pio/build/esp32c6/firmware.bin \
  --output build/hello-esp32c6.prg32
```

Run the QEMU cartridge:

```bash
prg32-qemu run build/hello-qemu.prg32
```

Upload to the physical board. Replace the port with your system's port:

```bash
# Linux
prg32-upload --port /dev/ttyACM0 build/hello-esp32c6.prg32

# macOS
prg32-upload --port /dev/cu.usbmodem1101 build/hello-esp32c6.prg32

# Windows
prg32-upload --port COM4 build/hello-esp32c6.prg32
```

If the PRG32 SDK exposes upload as a PlatformIO target, use the equivalent:

```bash
pio run -e esp32c6 -t upload --upload-port /dev/ttyACM0
```

## Build With ESP-IDF

Open a shell where ESP-IDF is exported:

```bash
. "$HOME/esp/esp-idf/export.sh"
```

Create the minimal ESP-IDF project files:

```bash
mkdir -p main
cat > CMakeLists.txt <<'EOF'
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(prg32_hello_world)
EOF

cat > main/CMakeLists.txt <<'EOF'
idf_component_register(SRCS "../src/main.c" INCLUDE_DIRS "../include")
EOF
```

Build the QEMU target:

```bash
idf.py -B build-qemu set-target esp32c3
idf.py -B build-qemu build
prg32-cart build \
  --architecture qemu \
  --input build-qemu/prg32_hello_world.bin \
  --output build/hello-qemu.prg32
prg32-qemu run build/hello-qemu.prg32
```

Build and upload the ESP32-C6 target:

```bash
idf.py -B build-esp32c6 set-target esp32c6
idf.py -B build-esp32c6 build
prg32-cart build \
  --architecture esp32c6 \
  --input build-esp32c6/prg32_hello_world.bin \
  --output build/hello-esp32c6.prg32
prg32-upload --port /dev/ttyACM0 build/hello-esp32c6.prg32
```

If your board firmware expects the whole application flashed instead of a
cartridge upload, use ESP-IDF directly:

```bash
idf.py -B build-esp32c6 -p /dev/ttyACM0 flash monitor
```

## Create The Publishing Package

The Store package is a zip file with:

- `manifest.json`
- `icon.png`
- one or more `.prg32` files
- optional `splash.png`

Create `manifest.json`:

```json
{
  "abi": "prg32-metadata-1.0",
  "id": "edu.example.hello",
  "title": "Hello PRG32",
  "version": "1.0.0",
  "summary": "A minimal hello world cartridge.",
  "description": "Draws Hello, PRG32 on the screen and verifies the local cartridge build pipeline.",
  "authors": [
    {
      "name": "Your Name",
      "email": "you@example.edu"
    }
  ],
  "license": "MIT",
  "homepage": "",
  "repository": "",
  "tags": ["hello-world", "tutorial"],
  "runtime": {
    "platform": "PRG32",
    "isa": "RV32I"
  },
  "assets": {
    "icon": "icon.png"
  },
  "architectures": [
    {
      "id": "qemu",
      "file": "hello-qemu.prg32"
    },
    {
      "id": "esp32c6",
      "file": "hello-esp32c6.prg32"
    }
  ],
  "colophon": {
    "abi": "prg32-colophon-1.0",
    "title": "Hello PRG32",
    "version": "1.0.0",
    "developer": {
      "name": "Your Name"
    },
    "authors": [],
    "controls": [
      {
        "input": "START",
        "action": "Return to launcher"
      }
    ]
  }
}
```

Copy files into `dist/package` and zip them:

```bash
rm -rf dist/package
mkdir -p dist/package
cp manifest.json dist/package/
cp assets/icon.png dist/package/
cp build/hello-qemu.prg32 dist/package/
cp build/hello-esp32c6.prg32 dist/package/

cd dist/package
zip -r ../hello-prg32-1.0.0.zip .
cd ../..
```

Verify the package:

```bash
unzip -l dist/hello-prg32-1.0.0.zip
```

You should see `manifest.json`, `icon.png`, `hello-qemu.prg32`, and
`hello-esp32c6.prg32`.

## Publish To Cartridge Store

Start the Store locally, if needed:

```bash
cd /path/to/CartridgeStore
export SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
python3 app.py
```

Log in in the browser at:

```text
http://127.0.0.1:5080/auth/login
```

Default development account:

```text
username: admin
password: password
```

Use the browser:

1. Open `http://127.0.0.1:5080/publish`.
2. Select `dist/hello-prg32-1.0.0.zip`.
3. Upload the package.
4. Open `/editor/submissions`.
5. Verify the submission.
6. Open `/games/edu.example.hello`.

Use the API:

```bash
STORE=http://127.0.0.1:5080
curl -c cookies.txt -b cookies.txt \
  -X POST "$STORE/auth/login" \
  -F username=admin \
  -F password=password

TOKEN=$(
  curl -s -c cookies.txt -b cookies.txt \
    -H 'Content-Type: application/json' \
    -d '{"label":"hello publish"}' \
    "$STORE/auth/tokens" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
)

curl -X POST "$STORE/api/publish/bundle" \
  -H "Authorization: Bearer $TOKEN" \
  -F bundle=@dist/hello-prg32-1.0.0.zip
```

The response contains a `submission_id`. Verify it as an editor:

```bash
curl -X POST "$STORE/api/submissions/1/verify" \
  -c cookies.txt -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Replace `1` with the `submission_id` from the upload response.

## Troubleshooting Checklist

Missing `pio`:

```bash
python3 -m platformio --version
python3 -m pip install --user platformio
```

Missing `idf.py`:

```bash
. "$HOME/esp/esp-idf/export.sh"
idf.py --version
```

Missing QEMU:

```bash
qemu-system-riscv32 --version || qemu-system-xtensa --version
```

No serial port:

```bash
# Linux
ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null

# macOS
ls /dev/cu.usb* 2>/dev/null

# Windows PowerShell
python -m serial.tools.list_ports
```

Linux permission denied on serial port:

```bash
sudo usermod -aG dialout "$USER"
```

Then log out and back in.

Store rejects the package:

- Ensure the zip contains `manifest.json` at the root.
- Ensure `manifest.abi` is `prg32-metadata-1.0`.
- Ensure `manifest.assets.icon` points to a PNG or JPEG in the zip.
- Ensure every `architectures[].file` points to a `.prg32` file in the zip.
- Ensure each architecture id is `qemu` or `esp32c6`.

QEMU works but hardware does not:

- Rebuild the `esp32c6` cartridge, not the `qemu` cartridge.
- Check the board port.
- Check that the board is running PRG32 firmware with cartridge upload support.
- Try a lower upload baud rate if your uploader supports it.

## References

- PlatformIO QEMU documentation: <https://docs.platformio.org/en/latest/advanced/unit-testing/simulators/qemu.html>
- ESP-IDF setup for Linux and macOS: <https://docs.espressif.com/projects/esp-idf/en/latest/esp32/get-started/linux-macos-setup.html>
- ESP-IDF `idf.py` command reference: <https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-guides/tools/idf-py.html>
- Cartridge Store API package format: [api.md](api.md)
