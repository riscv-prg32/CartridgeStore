---
title: Blockly
---

# Blockly Game Blocks

## Stored format

Projects save the Blockly workspace serialization in JSON:

```json
{
  "blocks": {
    "languageVersion": 0,
    "blocks": []
  }
}
```

This is stored in `projects.blocks_json`. **Generate C** (or **Generate Assembly**, see the [generated code guide](/docs/construction-kit/generated-code)) turns it into a
checked game IR (`prg32-construction-kit-game-1.1`) and then into C; the
browser simulator reads the same JSON into the same IR.

## Game

| Block | C behaviour |
| --- | --- |
| `when game starts` | Body of `<prefix>_init`, run once. |
| `every frame update` | Body of `<prefix>_update`, run every frame (about 30 per second). |
| `every frame draw` | Body of `<prefix>_draw`, run after every update. |
| `comment` | A `/* ... */` comment in the C. |
| `show splash title ... for ms` | `prg32_splash_show_game(...)`; use it in *when game starts*. |

## Variables

All variables are whole numbers (`int`). Using a name anywhere creates it.

| Block | C behaviour |
| --- | --- |
| `set score to 0` | `score = 0;` (the first literal value is also the start value) |
| `change player_x by -3` | `player_x += -3;` |
| `keep player_x between 0 and 304` | two boundary checks (a clamp) |
| `wrap ship_x around 0 to 319` | leaving one end re-enters at the other |
| `set target_x to random from 0 to 304` | `prg32_kit_random(0, 304)`, both ends included |

## Lists

| Block | C behaviour |
| --- | --- |
| `make list bricks with 60 items, all 1` | `static int bricks[60];` filled with 1 |
| `set item i of bricks to 0` | bounds-checked write |
| `change item i of bricks by -1` | bounds-checked read and write |

Read an item in any field with `bricks[i]`; positions start at 0. A list holds
1 to 1024 items. Reading outside the list gives 0 and writing outside the list
does nothing, in the simulator and in C (`prg32_kit_get` / `prg32_kit_set`).

## Logic

| Block | C behaviour |
| --- | --- |
| `if <condition>` | `if (condition) { ... }` |
| `if <condition> ... else ...` | `if (...) { ... } else { ... }` |
| `repeat with i from 0 to 9` | a counted loop; `i` takes every value from the first to the last number. A repeat runs at most 1024 times, so a game can never freeze. |
| `if rect ... touches rect ...` | `prg32_sprite_hitbox(...)`: x, y, width, height of two rectangles |

## Input

| Block | C behaviour |
| --- | --- |
| `if button LEFT is held` | `if (input & PRG32_BTN_LEFT)`: true on every frame the button is down |
| `if button A was just pressed` | true only on the first frame of a press (edge detection) |

The button list includes the second controller: *player 2 left/right/up/down/A/B*
(`PRG32_P2_BTN_*`). In the simulator, player 2 uses `J L I K` for the
directions and `U`/`O` for A/B.

## Drawing

| Block | C behaviour |
| --- | --- |
| `clear screen BLACK` | `prg32_gfx_clear` |
| `draw rectangle x y w h color` | `prg32_gfx_rect` |
| `draw outline x y w h color` | four one-pixel rectangles |
| `draw rectangle ... color value <expr>` | `prg32_gfx_rect` with an RGB565 expression, e.g. `rgb(255, 128, 0)` or `row_color[r]` |
| `draw pixel` | `prg32_gfx_pixel` |
| `draw line from x y to x y` | Bresenham's line algorithm (`prg32_kit_draw_line`) |
| `draw outline/filled circle` | midpoint circle algorithm (`prg32_kit_draw_circle`) |
| `draw text` | `prg32_gfx_text8` with the PRG32 8 x 8 font |
| `draw number` | the value as decimal text (`prg32_kit_draw_number`) |
| `draw picture x y color size` | an 8 x 8 picture typed as eight rows of `#` and `.`; `size 2` draws it 16 x 16; `.` is see-through |

Colours: black, white, red, green, blue, yellow, cyan, magenta, orange, pink,
gray, dark gray, brown, purple, navy, lime.

## Sprites and tiles

| Block | C behaviour |
| --- | --- |
| `draw 8x8 sprite x y fg bg` | `prg32_sprite_draw_8x8` (PRG32 sprite API, opaque background) |
| `define tile 1 fg bg` + eight rows | `prg32_tile_define` |
| `fill playfield layer 0 with tile 0` | `prg32_playfield_clear` |
| `put tile 3 on layer 0 at column x row y` | `prg32_playfield_put` |
| `scroll playfield layer 0 to x y` | `prg32_playfield_scroll` |
| `move playfield camera to x y` | `prg32_playfield_camera` |
| `draw playfield layer 0 opaque / tile 0 see-through` | `prg32_playfield_draw` |

Read a tile back with `tile(layer, column, row)`. Playfields are 64 x 32
tiles; 40 x 25 are visible. Define tile 0 explicitly: the ESP32 firmware
paints an undefined tile with black, PRG32-QT skips it.

## Palette

| Block | C behaviour |
| --- | --- |
| `palette index 1 color RED` | `prg32_palette_set` |
| `clear screen with palette index` | `prg32_gfx_clear_indexed` |
| `draw indexed rectangle` / `draw indexed pixel` | `prg32_gfx_rect_indexed` / `prg32_gfx_pixel_indexed` |

## Sound

| Block | C behaviour |
| --- | --- |
| `play beep freq 880 ms 80` | nearest MIDI note on channel 0 (`prg32_audio_note`), C3-C6 range |
| `play MIDI note 60 on channel 0 for 250 ms` | `prg32_audio_note` with the default instrument |
| `stop sound on channel 0` | `prg32_audio_note_off` |
| `set master volume to 200` | `prg32_audio_set_master_volume` (0-255) |

## Scores and status

| Block | C behaviour |
| --- | --- |
| `show in status band SCORE number score` | text in the firmware game-info band under the game; redrawn only when it changes |
| `save high score score` | `prg32_score_submit_current_player` |
| `show scoreboard titled ...` | `prg32_scoreboard_show` (waits for A, B or START) |
| `ask the player's name` | `prg32_score_player_prompt` (on-screen keyboard) |

## Multiplayer

| Block | C behaviour |
| --- | --- |
| `join multiplayer game` | `prg32_multiplayer_join` (Cartridge Store relay) |
| `share my position x y look` | `prg32_multiplayer_set_local_state` and `prg32_multiplayer_tick` |

Read other players with `peers()`, `peer_x(i)`, `peer_y(i)`, `peer_look(i)`.
The simulator and QEMU are offline: `peers()` is 0 there.

## Expressions

Text fields accept small integer expressions:

```text
150        player_x + 8        score * 2        bricks[row * 10 + col]
abs(dx) < 4        sin(angle) * 9 / 256        random(1, 6)        frame() % 8 < 5
```

An expression may use:

- whole numbers (`16`, `-3`, `0x1F`) and variable names;
- list items `name[position]`;
- PRG32 constants: `PRG32_GAME_W`, `PRG32_GAME_H`, `PRG32_SCREEN_W`, `PRG32_SCREEN_H`,
  `PRG32_TILE_*`, `PRG32_PLAYFIELD_*`, `PRG32_BTN_*`, `PRG32_P2_BTN_*`, `PRG32_COLOR_*`;
- parentheses and the C operators `+ - * / % < > <= >= == != && || ! & | ^ ~ << >>`;
- these kit functions:

| Function | Result |
| --- | --- |
| `abs(x)`, `sign(x)` | absolute value; -1, 0 or 1 |
| `min(a, b)`, `max(a, b)`, `clamp(x, low, high)` | smaller, larger, limited value |
| `sin(deg)`, `cos(deg)` | -256..256 (256 means 1.0), angle in degrees |
| `rgb(r, g, b)` | an RGB565 colour from 0-255 parts |
| `random(low, high)` | a random whole number, both ends included |
| `frame()` | frames finished since the game started |
| `tile(layer, column, row)` | the tile number in a playfield |
| `peers()`, `peer_x(i)`, `peer_y(i)`, `peer_look(i)` | other multiplayer players |

Anything else is replaced by the block's default value, and the replacement is
listed under **Warnings** after **Generate C**. That includes unknown
functions (`rand()`), decimals (`1.5`), quotes, semicolons, braces,
assignments, comments and `#` lines, so a text field can never add hidden C
code.

Some details students may notice:

- Names are not case-sensitive: `Player_X` and `player_x` are the same variable.
- Division works like C integers on RISC-V: `7 / 2` is `3`, `-7 / 2` is `-3`,
  and dividing by zero gives `-1` (the remainder gives the dividend) instead
  of crashing. The simulator does the same. In plain C, dividing by zero is
  not allowed, so when the number on the right of `/` or `%` is not a fixed
  number like `2`, the generated C calls the small helpers `prg32_kit_div` and
  `prg32_kit_mod` that give these answers on purpose.
- Names that C already uses get `_var` added: a variable called `input`, `int`
  or `uint32_t` becomes `input_var`, `int_var` or `uint32_t_var` in the generated C.
- The PRG32 8x8 font only has the printable ASCII characters (space to `~`).
  Any other character in a **draw text**, **status band**, **splash** or
  **scoreboard** block, such as `é` or an emoji, becomes `?`, in the simulator
  and on the console alike.
- Text in **draw text** and **comment** blocks is escaped, so quotes and `*/`
  stay inside the string or comment.
- The first **set** block for a variable also gives the variable its starting
  value, when that value is a plain whole number such as `150`, `-3` or `0x10`.

## Helpers in the generated C

Blocks such as *draw line* or list items need a few lines of support code. The
generator writes those helpers (`prg32_kit_get`, `prg32_kit_draw_line`,
`prg32_kit_sin`, ...) at the top of the same C file, and only the ones the
game uses, so students can read every line that runs. No library, no
`malloc`, no floating point.

## Simulator fidelity

The simulator draws into a 320 x 200 RGB565 framebuffer with the PRG32
firmware's 8 x 8 font and drawing rules, and runs at 30 frames per second.
For the example games, title screens rendered by the simulator are identical,
pixel for pixel, to the framebuffer read from the PRG32 QEMU firmware. Audio
is approximated with the browser's oscillator; random numbers differ.

See the [PRG32 feature coverage guide](/docs/construction-kit/cartridge-build)
for which PRG32 services are available in Blocks, in the simulator and in
Advanced C.
