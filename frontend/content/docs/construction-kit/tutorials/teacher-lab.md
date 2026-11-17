---
title: Teacher lab
---

# Tutorial 5: Teacher Lab Flow

Goal: run a 45-minute classroom activity.

## Preparation

1. Start PRG32-Construction-Kit. With Docker (`docker compose up -d --build`)
   cartridge builds work out of the box. Check them before class with
   `docker compose exec prg32-construction-kit python tools/check_build.py --students 10 --windows 2`
   (see the [cartridge build guide](/docs/construction-kit/cartridge-build)).
2. Optional: start Cartridge Store.
3. Optional: connect a PRG32 device or QEMU workflow.
4. Test that students can open the web app.

## 0-5 minutes: demo

Show the starter project. Move the player square in the simulator.

## 5-20 minutes: student build

Students modify:

- player color;
- player speed;
- start position;
- title text.

## 20-30 minutes: generated C discussion

Students click **Generate C** and find the C statement produced by one block.
Older students can choose **C + Assembly** in the **Generated code** list,
click **Generate C + Assembly**, and find the same block in the
**Generated Assembly** tab: its comment shows the C line, and every
instruction says what it does (see the [generated code guide](/docs/construction-kit/generated-code)).

## 30-40 minutes: sprites and artifacts

Students draw a sprite, convert it to C, and download the artifact.
If a PRG32 board or QEMU is available, students click **Download .prg32**
and load their own PRG32 cartridge.

## 40-45 minutes: reflection

Ask:

- What block changed a variable?
- What C statement did it become?
- Which RISC-V instructions do the same work?
- Why does the simulator help before hardware deployment?
- What is inside a `.prg32` cartridge compared with the generated C?

## Next: a unit on classic games

The five complete games in `examples/games/` each come with a 90-120 minute
tutorial and slide deck (`docs/tutorials/games/`, slides at
`/docs/presentations/<game>.html`). Pong introduces the game loop and
collisions; Breakout lists; Space Invaders pictures and object pools;
Asteroids fixed-point physics; Snake tiles and ring buffers. Each deck ends
with exercises and a check-your-understanding question.
