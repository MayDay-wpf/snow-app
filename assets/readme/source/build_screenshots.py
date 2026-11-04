#!/usr/bin/env python3
"""Build the README screenshot assets: annotated desktop overview and mobile pair.

Usage:
  python build_screenshots.py <path-to-desktop-screenshot.png> [zh|en|both]
  python build_screenshots.py --reannotate [zh|en|both]

The desktop capture is the app's own window screenshot (the one linked from the
project README). It is not stored in the repository, so pass the file you
captured or downloaded. `--reannotate` rewrites the lane labels of the already
published annotated images in place, which is enough when only the wording
changes and the original capture is unavailable.

Outputs (both languages by default):
  screenshots/desktop-annotated.png      Chinese lane labels
  screenshots/desktop-annotated.en.png   English lane labels
  screenshots/mobile-pair.png            shared by both READMEs
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

from theme import ASSETS

OUT = os.path.join(ASSETS, "screenshots")
os.makedirs(OUT, exist_ok=True)

# PIL needs RGB tuples; values mirror the palette in theme.py
PAPER = (255, 255, 255)
INK = (11, 18, 32)
LINE = (229, 231, 235)
PILL = (245, 247, 249)
BRAND = (115, 175, 209)

FONT_PATH = next(
    p for p in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"] if os.path.exists(p)
)

# lane centres in the reference capture: 3050px wide, three-column layout
LANES = {
    "zh": [
        (0.5 * (60 + 490), "1  侧边栏 · 会话与项目"),
        (0.5 * (540 + 1490), "2  编码 Agent 会话与工具调用"),
        (0.5 * (1530 + 2460), "3  面板 · 浏览器 / 终端 / Git"),
    ],
    "en": [
        (0.5 * (60 + 490), "1  Sidebar - sessions, projects"),
        (0.5 * (540 + 1490), "2  Coding agent session"),
        (0.5 * (1530 + 2460), "3  Panel - browser, terminal, Git"),
    ],
}
TARGET_W = 2400


def font(size):
    return ImageFont.truetype(FONT_PATH, size)


def flatten(img):
    """Composite an RGBA capture (transparent window shadow) onto white."""
    base = Image.new("RGB", img.size, PAPER)
    base.paste(img, (0, 0), img)
    return base


def window_shot(source):
    """Flatten the shadow area, crop to the opaque window plus 12px, scale to TARGET_W."""
    src = Image.open(source)
    alpha = src.getchannel("A").point(lambda v: 255 if v > 250 else 0)
    x0, y0, x1, y1 = alpha.getbbox()
    pad = 12
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(src.width, x1 + pad), min(src.height, y1 + pad)
    shot = flatten(src).crop((x0, y0, x1, y1))
    scale = TARGET_W / shot.width
    shot = shot.resize((TARGET_W, round(shot.height * scale)), Image.LANCZOS)
    print("window box", (x0, y0, x1, y1), "scale", round(scale, 4), "->", shot.size)
    return shot, scale, x0


def draw_lanes(canvas, positions, lang, top):
    """Draw the lane pills and their leader lines at the given x positions."""
    d = ImageDraw.Draw(canvas)
    f = font(32)
    for cx, (_, text) in zip(positions, LANES[lang]):
        pw = d.textlength(text, font=f) + 56
        x0 = max(8, min(cx - pw / 2, canvas.width - pw - 8))
        d.rounded_rectangle([x0, 26, x0 + pw, 82], 28, fill=PILL, outline=LINE, width=2)
        d.text((x0 + 28, 54), text, font=f, fill=INK, anchor="lm")
        d.line([cx, 82, cx, top], fill=BRAND, width=3)


def build_annotated(shot, scale, offset_x, lang):
    w, h = shot.size
    top = 104
    canvas = Image.new("RGB", (w, h + top + 12), PAPER)
    canvas.paste(shot, (0, top))
    draw_lanes(canvas, [(orig_cx - offset_x) * scale for orig_cx, _ in LANES[lang]], lang, top)
    name = "desktop-annotated.png" if lang == "zh" else "desktop-annotated.en.png"
    path = os.path.join(OUT, name)
    canvas.save(path, optimize=True)
    print("wrote", os.path.relpath(path, ASSETS))


def lane_centers(img):
    """Find the x centres of the brand-coloured leader lines in an annotated image."""
    y, centers, start = 90, [], None
    for x in range(img.width):
        hit = img.getpixel((x, y)) == BRAND
        if hit and start is None:
            start = x
        elif not hit and start is not None:
            centers.append((start + x - 1) / 2)
            start = None
    if start is not None:
        centers.append((start + img.width - 1) / 2)
    return centers


def reannotate(lang):
    """Rewrite the lane labels of a published annotated image in place."""
    name = "desktop-annotated.png" if lang == "zh" else "desktop-annotated.en.png"
    path = os.path.join(OUT, name)
    img = Image.open(path).convert("RGB")
    centers = lane_centers(img)
    if len(centers) != len(LANES[lang]):
        raise SystemExit(f"{name}: expected {len(LANES[lang])} lane lines, found {len(centers)}")
    ImageDraw.Draw(img).rectangle([0, 0, img.width, 104], fill=PAPER)
    draw_lanes(img, centers, lang, 104)
    img.save(path, optimize=True)
    print("wrote", os.path.relpath(path, ASSETS))


def build_mobile_pair():
    docs = os.path.normpath(os.path.join(ASSETS, "..", "..", "docs", "images"))
    imgs = []
    for name in ("mobile-conversation.png", "mobile-actions.png"):
        src = Image.open(os.path.join(docs, name)).convert("RGB")
        mask = Image.new("L", src.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, src.width - 1, src.height - 1], 26, fill=255)
        out = Image.new("RGBA", src.size, (0, 0, 0, 0))
        out.paste(src, (0, 0), mask)
        imgs.append(out)
    gap, pad = 56, 48
    canvas = Image.new(
        "RGB", (pad * 2 + imgs[0].width * 2 + gap, pad * 2 + imgs[0].height), PAPER
    )
    d = ImageDraw.Draw(canvas)
    x = pad
    for im in imgs:
        canvas.paste(im.convert("RGB"), (x, pad), im)
        d.rounded_rectangle(
            [x, pad, x + im.width - 1, pad + im.height - 1], 26, outline=LINE, width=2
        )
        x += im.width + gap
    path = os.path.join(OUT, "mobile-pair.png")
    canvas.save(path, optimize=True)
    print("wrote", os.path.relpath(path, ASSETS))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    langs = sys.argv[2] if len(sys.argv) > 2 else "both"
    langs = ["zh", "en"] if langs == "both" else [langs]
    if sys.argv[1] == "--reannotate":
        for lang in langs:
            reannotate(lang)
        raise SystemExit
    shot, scale, offset_x = window_shot(sys.argv[1])
    for lang in langs:
        build_annotated(shot, scale, offset_x, lang)
    build_mobile_pair()
