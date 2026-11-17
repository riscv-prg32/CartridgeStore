---
title: How-to recipes
---

# How-To Recipes

## How to use the simulator gamepad

Below the simulator screen, the classic-style gamepad lets students test games with a mouse or touch screen. Its direction pad sends `UP`, `DOWN`, `LEFT`, and `RIGHT`; the red buttons send `A` and `B`; and the middle buttons send `SELECT` and `START`. These are the same names used by the **if button ... is held** and **if button ... was just pressed** blocks. Player 2 uses the keys `J L I K` (directions) and `U`/`O` (A/B). A tap shorter than one frame is still seen by the game. Keyboard controls remain available: arrow keys, `Z`/`X`, `Enter`, and `Shift`.

## How to make a moving player

1. Add `when game starts`.
2. Add `set player_x to 150` and `set player_y to 180`.
3. Add `every frame update`.
4. Add `if button LEFT is held`, then `change player_x by -3`.
5. Add `if button RIGHT is held`, then `change player_x by 3`.
6. Add `keep player_x between 0 and 304`.
7. Add `every frame draw`.
8. Add `clear screen BLACK` and `draw rectangle x player_x y player_y w 16 h 16 color YELLOW`.

## How to inspect generated C

1. Open the project editor.
2. Click **Save**.
3. Click **Generate C**.
4. Read the C panel. Match each block to one generated C statement.

## How to inspect generated RISC-V assembly

1. Open the project editor.
2. In the **Generated code** list next to the Generate button, choose
   **Assembly (RISC-V)** or **C + Assembly**.
3. Click **Generate Assembly** (or **Generate C + Assembly**).
4. Open the **Generated Assembly** tab. Above each group of instructions a
   comment repeats the block and shows its C line (`C: ...`). Find the same
   block in the **Generated C** tab and compare.
5. **Compile Cartridge** with **Assembly (RISC-V)** chosen builds the
   cartridge from the assembly instead of the C. See the [generated code
   guide](/docs/construction-kit/generated-code).

## How to download a PRG32 cartridge

1. Open the project editor.
2. Click **Download .prg32**. The browser saves a file such as `my-game-esp32c6.prg32`.
3. To test in the emulator instead, open the arrow next to the button and choose **QEMU emulator**.
4. Upload the PRG32 cartridge to a cartridge slot on the board.

The server needs the PRG32 toolchain for this step. The Docker image already
has it. If the editor says "this server cannot compile PRG32 cartridges yet",
nothing is downloaded: ask your teacher to follow
the [cartridge build guide](/docs/construction-kit/cartridge-build), and read
the **Debug Log** tab to see what is missing.

## How to start from a complete game

1. On the dashboard click **Examples**.
2. Choose an entry marked **complete game** (Pong, Breakout, Space Invaders, Asteroids or Snake) and click **Add**.
3. Follow its tutorial in `docs/tutorials/games/`, or open the slides at `/docs/presentations/<game>.html`.

## How to check a cartridge on QEMU and PRG32-QT

Run `tools/runtime_check.py` (see `runtime_check.md`). It builds the example
games for both targets, runs them on the QEMU firmware and in PRG32-QT, and
saves a screenshot from each.

## How to create an artifact

Artifacts are created by:

- generating C from a project;
- preparing a cartridge bundle;
- downloading a `.prg32` cartridge (the cartridge is also kept as an artifact);
- converting a sprite to C;
- uploading a file on the Artifacts page.

## How to move data to another machine

1. Stop the app.
2. Copy the `data/` directory.
3. Start the app on the new machine with `PRG32_KIT_DATA` pointing at that copy.

## How to use with a separate Cartridge Store

1. Start Cartridge Store.
2. Start PRG32-Construction-Kit.
3. Open **Publish**.
4. Create a profile pointing at the store URL.
5. Prepare a cartridge bundle from a project.
6. Publish the bundle.
