---
title: Sprite editor
---

# Sprite and Image Editor

The Sprite Lab provides a small pixel editor for classroom game assets.

## Features

- Create, load, update, and delete sprite resources through `/api/sprites`.
- Paint pixels on a grid.
- Use an eraser for transparent pixels.
- Import an image and downsample it to the sprite grid.
- Export a PNG from the browser.
- Convert sprite JSON to a C `uint16_t` RGB565 array.

## Sprite JSON shape

```json
{
  "name": "player",
  "width": 16,
  "height": 16,
  "pixels": [
    ["transparent", "#ffd800"]
  ],
  "data_url": "data:image/png;base64,..."
}
```

The `pixels` field is the source of truth for conversion. `data_url` is a convenience preview/export image.

## Convert to C

Click **Convert to C** in Sprite Lab. The backend creates a `sprite_c_source` artifact.

Example output:

```c
#define PLAYER_WIDTH 16
#define PLAYER_HEIGHT 16
static const uint16_t player_pixels[256] = {
    0x0000, 0xFFE0, ...
};
```
