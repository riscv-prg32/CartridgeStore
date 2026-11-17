---
title: Catch game
---

# Tutorial 2: Make a Catch Game

Goal: move the player left and right and keep it on screen.

## 1. Start from Tutorial 1

Open your project or create a new one.

## 2. Add movement

In `every frame update`, add:

```text
if button LEFT is held
  change player_x by -3

if button RIGHT is held
  change player_x by 3

keep player_x between 0 and 304
```

## 3. Test movement

1. Click **Play**.
2. Use the left and right arrow keys.
3. Check that the square cannot leave the screen.

## 4. Inspect the C

Click **Generate C** and find:

```c
uint32_t input = prg32_input_read();
if (input & PRG32_BTN_LEFT) {
    player_x += -3;
}
```

Discuss why the block uses button language but the C uses a bitmask.
