# Getting Started With PRG32 Game Development

Build cartridges with the tooling in the current
[PRG32 repository](https://github.com/riscv-prg32/PRG32). Cartridge Store
accepts a ZIP bundle containing a manifest and one or more portable `.prg32`
files. This guide uses the checked-in Blackjack game as a concrete example.

## Prepare the development environment

Clone PRG32 and install ESP-IDF and its RISC-V toolchain as described in the
[PRG32 getting-started guide](https://github.com/riscv-prg32/PRG32/blob/main/docs/usage/getting_started.md).
Run these commands from the PRG32 repository root:

```bash
source "$HOME/esp-idf/export.sh"
python3 -m prg32 doctor
python3 -m prg32 abi check
```

On Windows, use an ESP-IDF terminal and `python -m prg32` in place of
`python3 -m prg32`. PlatformIO can build resident ESP32-C6 firmware, while
portable cartridge builds use the PRG32 Python tooling and ESP-IDF toolchain.

## Build portable cartridges

The source exports `blackjack_init`, `blackjack_update`, and
`blackjack_draw`, so its entry-point prefix is `blackjack`. Build one
artifact for each Store architecture:

```bash
mkdir -p build/store-blackjack
python3 -m prg32 cartridge build cartridges/blackjack/game.c \
  --portable --architecture esp32c6 --entry-prefix blackjack \
  --name blackjack --out build/store-blackjack/blackjack-esp32c6.prg32
python3 -m prg32 cartridge build cartridges/blackjack/game.c \
  --portable --architecture qemu --entry-prefix blackjack \
  --name blackjack --out build/store-blackjack/blackjack-qemu.prg32
python3 -m prg32 cartridge summary build/store-blackjack/blackjack-esp32c6.prg32
```

See the [PRG32 cartridge guide](https://github.com/riscv-prg32/PRG32/blob/main/docs/software/cartridges.md)
for your own C or assembly source, entry points, ABI requirements, and
board/QEMU run commands. Current tooling builds ABI-table cartridges;
firmware-specific absolute-import builds are unsupported.

## Package for Cartridge Store

Create `build/store-blackjack/manifest.json` using the
[bundle format](api.md#bundle-publish). The manifest must name the actual
cartridge files and an icon in the same directory:

```json
{
  "abi": "prg32-metadata-1.0",
  "id": "org.example.blackjack",
  "title": "Blackjack",
  "version": "1.0.0",
  "summary": "Classroom Blackjack cartridge",
  "authors": [{"name": "Your Name"}],
  "tags": ["game"],
  "assets": {"icon": "icon.png"},
  "architectures": [
    {"id": "esp32c6", "file": "blackjack-esp32c6.prg32"},
    {"id": "qemu", "file": "blackjack-qemu.prg32"}
  ]
}
```

For a real publication, use your own game ID, authors, version, and artwork.
Place `icon.png` beside the manifest, then package and submit:

```bash
python3 -m prg32 store pack-bundle \
  --manifest build/store-blackjack/manifest.json \
  --out build/store-blackjack.zip
python3 -m prg32 store publish-bundle build/store-blackjack.zip \
  --store-url http://127.0.0.1:5080 --token YOUR_TOKEN
```

The Store returns a pending submission. An editor must verify it before the
game appears in `GET /api/games`. See [Getting Started](getting_started.md)
for server setup and [the API guide](api.md) for authentication and review.

PRG32 firmware and host tools validate cartridge ABI compatibility when
downloading or deploying a cartridge. Rebuild incompatible cartridges from
the current PRG32 checkout before publishing them.
