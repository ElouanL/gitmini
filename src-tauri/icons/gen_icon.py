#!/usr/bin/env python3
"""Generates `icon-source.png` (1024x1024): the gitmini app icon, an orange commit mark on a dark rounded tile.
The mark geometry is shared with `src/lib/components/ui/Logo.svelte`; change both together.
Usage: python3 gen_icon.py, then `cargo tauri icon icon-source.png -o <tmp>` and copy 32x32.png, 128x128.png,
128x128@2x.png, icon.png, icon.icns and icon.ico from <tmp> back here (the other generated sizes are not shipped)."""
from PIL import Image, ImageDraw

S = 2048  # canvas
SS = 2  # extra supersampling on top of the final 2x reduction (anti-aliasing)
TILE = (32, 41, 50, 255)
ORANGE = (242, 75, 41, 255)

# Mark geometry, in its own unit space (origin at the top-left of its bounding box).
R = 21  # node radius
W = 15  # stroke width
STEM_X = 21
TOP_Y, BOTTOM_Y = 21, 121.7  # stem nodes
BRANCH_X, BRANCH_Y = 73.8, 56.2  # right node
JOIN_Y = 107  # where the branch leaves the stem
MARK_H = BOTTOM_Y + R
CENTROID_X = 36.4  # the mark is centred on its centre of mass, not its bounding box (the right node is light)

TILE_MARGIN, TILE_RADIUS = 100, 440
MARK_HEIGHT = 0.64 * (S - 2 * TILE_MARGIN)  # mark height relative to the tile

k = S * SS
img = Image.new("RGBA", (k, k), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle(
    [TILE_MARGIN * SS, TILE_MARGIN * SS, (S - TILE_MARGIN) * SS - 1, (S - TILE_MARGIN) * SS - 1],
    radius=TILE_RADIUS * SS,
    fill=TILE,
)

scale = MARK_HEIGHT * SS / MARK_H
ox = k / 2 - CENTROID_X * scale
oy = (k - MARK_H * scale) / 2


def pt(x, y):
    return (ox + x * scale, oy + y * scale)


def disc(x, y, r):
    cx, cy = pt(x, y)
    d.ellipse((cx - r * scale, cy - r * scale, cx + r * scale, cy + r * scale), fill=ORANGE)


def stroke(x1, y1, x2, y2, w):
    (ax, ay), (bx, by) = pt(x1, y1), pt(x2, y2)
    n = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
    nx, ny = -(by - ay) / n * w * scale / 2, (bx - ax) / n * w * scale / 2
    d.polygon([(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)], fill=ORANGE)
    disc(x1, y1, w / 2)
    disc(x2, y2, w / 2)


stroke(STEM_X, TOP_Y, STEM_X, BOTTOM_Y, W)
stroke(STEM_X, JOIN_Y, BRANCH_X, BRANCH_Y, W)
for x, y in ((STEM_X, TOP_Y), (STEM_X, BOTTOM_Y), (BRANCH_X, BRANCH_Y)):
    disc(x, y, R)

img.resize((1024, 1024), Image.LANCZOS).save("icon-source.png")
print("icon-source.png written")
