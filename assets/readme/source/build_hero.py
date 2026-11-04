#!/usr/bin/env python3
"""Build the README hero boards (hybrid: SVG layout + the real app icon).

The pixel wordmark mirrors the pixel "SNOW APP" mark shown on the app's welcome
screen; the icon is the real resources/icon@2x.png shipped with the app.
The layout SVG is a build intermediate and is written to the temp directory;
only the rendered PNG is published (raster inside SVG is not reliable on GitHub).

Usage: python build_hero.py [zh|en]
"""

import base64
import os
import subprocess
import sys
import tempfile

from theme import ASSETS, BRAND, FAINT, INK, LINE, MONO, PAPER, SANS, TEXT_2

CHROME_CANDIDATES = [
    os.environ.get("CHROME_PATH"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]


def chrome_binary():
    """Locate a usable Chrome for headless rendering."""
    for path in CHROME_CANDIDATES:
        if path and os.path.exists(path):
            return path
    raise SystemExit("Chrome not found, set CHROME_PATH")

GLYPHS = {
    "S": ["01110", "10000", "10000", "01110", "00001", "00001", "11110"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    " ": ["00000"] * 7,
}

COPY = {
    "zh": {
        "eyebrow": "桌面编码 Agent",
        "pitch": "读代码、改文件、跑命令、验结果，一个窗口里全部完成",
        "meta": ["macOS / Windows / Linux", "MIT License"],
        "title": "Snow App：桌面编码 Agent",
        "desc": "Snow App 的像素标识、编码 Agent 定位与平台信息。",
    },
    "en": {
        "eyebrow": "DESKTOP CODING AGENT",
        "pitch": "Reads code, edits files, runs commands and verifies the result",
        "meta": ["macOS / Windows / Linux", "MIT License"],
        "title": "Snow App: desktop coding agent",
        "desc": "Snow App pixel wordmark, coding agent positioning and platform metadata.",
    },
}

CELL = 10


def wordmark(text, x, y, cell=CELL, fill=INK):
    """Return SVG rects for a 5x7 pixel wordmark starting at (x, y)."""
    out = []
    cursor = x
    for ch in text:
        for r, row in enumerate(GLYPHS[ch]):
            run_start = None
            for c, bit in enumerate(row + "0"):
                if bit == "1" and run_start is None:
                    run_start = c
                elif bit == "0" and run_start is not None:
                    out.append(
                        f'<rect x="{cursor + run_start * cell}" y="{y + r * cell}" '
                        f'width="{(c - run_start) * cell}" height="{cell}" fill="{fill}"/>'
                    )
                    run_start = None
        cursor += 6 * cell  # 5 cells glyph + 1 cell gap
    return "".join(out)


def build_hero_svg(lang, icon_b64):
    c = COPY[lang]
    marks = wordmark("SNOW APP", 56, 122)
    meta_line = " · ".join(c["meta"])
    eyebrow_face = MONO if lang == "en" else SANS
    eyebrow_spacing = "3" if lang == "en" else "1.2"
    eyebrow_size = 18 if lang == "en" else 19
    return f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="1200" height="340" viewBox="0 0 1200 340" role="img" aria-labelledby="t d">
  <title id="t">{c["title"]}</title>
  <desc id="d">{c["desc"]}</desc>
  <rect width="1200" height="340" rx="18" fill="{PAPER}"/>
  <rect x="0.5" y="0.5" width="1199" height="339" rx="18" fill="none" stroke="{LINE}"/>

  <image x="56" y="46" width="46" height="46" xlink:href="data:image/png;base64,{icon_b64}"
         preserveAspectRatio="xMidYMid meet"/>
  <text x="120" y="76" font-family="{eyebrow_face}" font-size="{eyebrow_size}"
        letter-spacing="{eyebrow_spacing}" fill="{FAINT}">{c["eyebrow"]}</text>
  <rect x="120" y="88" width="72" height="3" rx="1.5" fill="{BRAND}"/>

  <g id="wordmark" shape-rendering="crispEdges">{marks}</g>

  <text x="56" y="252" font-family="{SANS}" font-size="22" fill="{TEXT_2}">{c["pitch"]}</text>
  <text x="56" y="298" font-family="{MONO}" font-size="17" letter-spacing="1.2"
        fill="{FAINT}">{meta_line}</text>

  <image x="930" y="60" width="220" height="220" xlink:href="data:image/png;base64,{icon_b64}"
         preserveAspectRatio="xMidYMid meet"/>
</svg>
'''


def render(svg_path, png_path, width, height):
    """Rasterise an SVG (or HTML) file with headless Chrome at 2x.

    Each call gets a private profile directory: sharing one profile between
    back-to-back headless runs makes Chrome intermittently emit a partially
    painted screenshot, which silently corrupts the published asset.
    """
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    profile = tempfile.mkdtemp(prefix="snow-readme-chrome-")
    cmd = [
        chrome_binary(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--default-background-color=00000000", "--force-device-scale-factor=2",
        f"--user-data-dir={profile}", f"--window-size={width},{height}",
        f"--screenshot={png_path}", "file:///" + svg_path.replace("\\", "/"),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if not os.path.exists(png_path):
        raise SystemExit(f"render failed ({res.returncode})\n{res.stdout[-2000:]}")
    print("rendered", os.path.relpath(png_path, ASSETS))


def main():
    langs = sys.argv[1:] or ["zh", "en"]
    icon_path = os.path.normpath(os.path.join(ASSETS, "..", "..", "resources", "icon@2x.png"))
    with open(icon_path, "rb") as fh:
        icon_b64 = base64.b64encode(fh.read()).decode("ascii")
    tmp = tempfile.mkdtemp(prefix="snow-readme-hero-")
    for lang in langs:
        layout = os.path.join(tmp, f"hero-layout.{lang}.svg")
        with open(layout, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(build_hero_svg(lang, icon_b64))
        render(layout, os.path.join(ASSETS, lang, "hero.png"), 1200, 340)


if __name__ == "__main__":
    main()
