---
title: Cartridge build
---

# Cartridge Build Guide

## What the app generates

When a student clicks **Generate C**, the app converts Blocks JSON to game IR and then deterministic C.
With **Assembly (RISC-V)** or **C + Assembly** chosen in the **Generated code**
list, the same game IR also becomes explained RISC-V (RV32IM) assembly, and
**Compile Cartridge** can build the cartridge from `game.S` instead of
`game.c`. See the [generated code guide](./generated-code).

Generated C exports three functions:

```c
void my_game_init(void);
void my_game_update(void);
void my_game_draw(void);
```

The function prefix comes from the project title, sanitized as a C identifier.

## Advanced C projects

Choose **Advanced C** in the project editor to write against the full portable
PRG32 cartridge ABI. `prg32.h` also declares resident-only services; the
cartridge toolchain reports an undefined symbol if one is used. Use
[PRG32's ABI specification](https://github.com/riscv-prg32/PRG32/blob/main/prg32/abi/prg32_abi.json)
to identify the portable functions. **Copy generated Blocks C** provides a
starting point. Save the C source before compiling. The source remains in the
project JSON export, and the bundle includes the exact saved file as
`source/game.c`. Define `<title_prefix>_init`, `<title_prefix>_update`, and
`<title_prefix>_draw` with `void` arguments; for a project titled "My Game",
the prefix is `my_game`. Only PRG32 and small freestanding standard headers
are accepted. Before building, the kit also rejects tricks that would let C
read files on the server while it compiles: directives hidden behind comments,
`%:` digraphs and `??=` trigraphs, inline assembly (`asm`, `__asm__`),
`_Pragma`, `__has_include`, and the `##` token-pasting operator. The PRG32
compiler checks the actual API calls and types.
List any firmware features the cartridge needs in **Required PRG32 features**.
The kit passes those names to PRG32's `--required-feature` option so an
incompatible runtime rejects the cartridge before execution. For Blocks
projects the kit works the features out from the blocks (sound blocks need
`audio`, tile blocks `tilemap`, and so on); projects that use multiplayer also
get the builder's `--multiplayer` option, which marks the cartridge header.
The supported feature set is derived from the blocks used by the project and
is written into the cartridge header before publication.

The browser simulator runs Blocks projects. Test Advanced C cartridges in
PRG32 QEMU or on the physical ESP32-C6 board. The editor does not compile C
proposed by an AI assistant or silently change saved source.

## Compile and download a cartridge

When a student clicks **Compile Cartridge**, the app:

1. saves the Blockly JSON;
2. regenerates C;
3. creates a build record;
4. writes `game.c`, `project.blocks.json`, and `game.ir.json` to `data/builds/<build_id>/`;
5. runs the configured PRG32 build command for `esp32c6` and `qemu` labels,
   with a private temporary folder `data/builds/<build_id>/tmp/` (removed
   afterwards) and a time limit of `PRG32_BUILD_TIMEOUT` seconds;
6. creates directly downloadable `.prg32` artifacts and a Cartridge Store bundle zip.

After a successful build, green download buttons appear above the editor. The
portable cartridge can be uploaded to a device slot through the PRG32 setup
page or the upstream `python3 -m prg32 esp32c6 upload` command.

## Download a .prg32 cartridge in one click

Students who only want the finished cartridge do not need to download the C
source. Click **Download .prg32** in the editor toolbar: the app saves the
project, generates C, compiles a cartridge for the PRG32 board (ESP32-C6), and
the browser downloads the `.prg32` file straight away. Use the small arrow next
to the button to choose **QEMU emulator** instead.

The generated C is still saved as an artifact and shown in the **Generated C**
tab, so it can always be inspected. If the PRG32 toolchain is not installed on
the server, no file is downloaded and the **Debug Log** explains why.

## PRG32 build command

Default (with the same Python that runs the kit):

```bash
<kit python> -m prg32 cartridge build
```

Installing the tools and the compiler for Docker, macOS, Linux and Windows is
covered by this guide and the [PRG32 getting-started guide](../prg32/getting-started).

The app appends:

```text
game.c --portable --architecture <esp32c6|qemu> --cart-ram-kib 64 --entry-prefix <prefix> --name <slug> --out <slug>-<architecture>.prg32
       [--required-feature <feature> ...] [--multiplayer]
```

The PRG32 tooling can be installed into the kit's Python environment from a
PRG32 checkout (`.venv/bin/pip install --no-deps -e ../PRG32`), or run from
that checkout with `PYTHONPATH`. The RISC-V compiler `riscv32-esp-elf-gcc` from ESP-IDF 5.4 must
be on `PATH`.

Override the command:

```bash
export PRG32_BUILD_COMMAND="python3 -m prg32 cartridge build"
```

PRG32's current default firmware profile provides 64 KiB of executable
cartridge RAM. The kit passes this limit explicitly so the builder catches an
oversized game before upload. Set `PRG32_CART_RAM_KIB` to the target firmware
profile's value when it differs from 64.

Only `PRG32_MAX_PARALLEL_BUILDS` builds compile at the same time; the others
wait for a free build slot. See `concurrent_builds.md`.

## Run a cartridge on QEMU or PRG32-QT

```bash
python3 -m prg32 qemu upload my-game-qemu.prg32
python3 -m prg32 qemu run
```

PRG32-QT runs both the `qemu` and the `esp32c6` cartridge: use **Import
Cartridge** in the app, or the headless runner
`prg32qt-headless my-game-qemu.prg32 300 --dump-ppm frame.ppm`.
`tools/runtime_check.py` automates both for the example games
(`runtime_check.md`).

## Source-only bundles

If the toolchain is missing, the bundle is marked `source-only` and includes:

- `manifest.json`
- `icon.png`
- `source/game.c`
- `source/project.blocks.json`
- `source/game.ir.json`
- `BUILD_TOOLCHAIN_REQUIRED.txt`

This is useful for teaching conversion even on laptops that cannot build cartridges.

## Publishable bundles

If one or more `.prg32` files are produced, the manifest includes architecture entries and the bundle is marked publishable.
