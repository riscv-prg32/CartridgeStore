---
title: First project
---

# Tutorial 1: First Blocks Project

Goal: create a tiny PRG32 game that draws a player square.

## 1. Create the project

1. Open the home page.
2. Click **New Project**.
3. Title it `First Square`.
4. Click **Create**.

## 2. Build the start state

In the Blocks area:

1. Drag `when game starts`.
2. Add `set player_x to 150`.
3. Add `set player_y to 180`.

## 3. Draw the square

1. Drag `every frame draw`.
2. Add `clear screen BLACK`.
3. Add `draw rectangle x player_x y player_y w 16 h 16 color YELLOW`.

## 4. Play online

Click **Play**. You should see a yellow square in the simulated PRG32 screen.

## 5. Save and export

1. Click **Save**.
2. Click **Export JSON**.

The downloaded file is a Blocks PRG32 game stored as JSON.

## 6. Get a cartridge for your PRG32

Click **Download .prg32**. The app compiles your blocks and your browser saves
a file such as `first-square-esp32c6.prg32`. That file is your PRG32 cartridge:
upload it to a cartridge slot on the board. To try it in the QEMU emulator,
open the arrow next to the button and choose **QEMU emulator**.
