"""Put a terminal recording GIF (from agg) inside a window: title bar, rounded corners, drop shadow.

GitHub strips CSS from READMEs, so the chrome is baked into the frames. A shadow needs a known background, so this
writes one GIF for GitHub's light theme and one for its dark theme; the README picks with <picture>.

    python3 -I demos/frame.py /tmp/raw.gif demos/pi-durable-sprites-light.gif demos/pi-durable-sprites-dark.gif

Needs Pillow (`pip install pillow`).
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

source, light_out, dark_out = (Path(arg) for arg in sys.argv[1:4])

RADIUS = 12
BAR = 40
PAD = 48  # room for the shadow
SHADOW_OFFSET = (0, 18)
SHADOW_BLUR = 22
TITLE = "pi-durable-sprites — demo"
TERMINAL_BG = (0x17, 0x14, 0x34)  # the agg theme's background, so the chrome and the frames join seamlessly
THEMES = {
    "light": {"page": (0xFF, 0xFF, 0xFF), "bar": (0x24, 0x20, 0x45), "title": (0xA3, 0x9A, 0xC1), "shadow": (0, 0, 0, 90)},
    "dark": {"page": (0x0D, 0x11, 0x17), "bar": (0x24, 0x20, 0x45), "title": (0xA3, 0x9A, 0xC1), "shadow": (0, 0, 0, 170)},
}
LIGHTS = [(0xFF, 0x5F, 0x57), (0xFE, 0xBC, 0x2E), (0x28, 0xC8, 0x40)]

font_dir = Path.home() / ".local/share/fonts/fonts/ttf"
try:
    font = ImageFont.truetype(str(font_dir / "JetBrainsMono-Medium.ttf"), 14)
except OSError:
    font = ImageFont.load_default()

gif = Image.open(source)
width, height = gif.size
window_w, window_h = width, height + BAR
canvas_w, canvas_h = window_w + 2 * PAD, window_h + 2 * PAD
window_box = (PAD, PAD, PAD + window_w, PAD + window_h)


def window_mask() -> Image.Image:
    mask = Image.new("L", (window_w, window_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, window_w - 1, window_h - 1), RADIUS, fill=255)
    return mask


def background(theme: dict) -> Image.Image:
    """Page color, the shadow, and the window's title bar; the terminal area is filled by each frame."""
    page = Image.new("RGBA", (canvas_w, canvas_h), theme["page"] + (255,))
    shadow = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    x0, y0, x1, y1 = window_box
    dx, dy = SHADOW_OFFSET
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + dx, y0 + dy, x1 + dx, y1 + dy), RADIUS, fill=theme["shadow"])
    shadow = shadow.filter(ImageFilter.GaussianBlur(SHADOW_BLUR))
    page = Image.alpha_composite(page, shadow)
    window = Image.new("RGBA", (window_w, window_h), TERMINAL_BG + (255,))
    draw = ImageDraw.Draw(window)
    draw.rectangle((0, 0, window_w, BAR), fill=theme["bar"])
    for index, color in enumerate(LIGHTS):
        cx = 20 + index * 22
        draw.ellipse((cx - 6, BAR / 2 - 6, cx + 6, BAR / 2 + 6), fill=color)
    text_w = draw.textlength(TITLE, font=font)
    draw.text(((window_w - text_w) / 2, BAR / 2 - 9), TITLE, font=font, fill=theme["title"])
    page.paste(window, (x0, y0), window_mask())
    return page


mask = window_mask()
for theme_name, out_path in (("light", light_out), ("dark", dark_out)):
    theme = THEMES[theme_name]
    base = background(theme)
    frames, durations = [], []
    for index in range(gif.n_frames):
        gif.seek(index)
        frame = gif.convert("RGBA")
        page = base.copy()
        # The frame sits below the title bar; the window mask rounds its bottom corners.
        window = Image.new("RGBA", (window_w, window_h), (0, 0, 0, 0))
        window.paste(frame, (0, BAR))
        page.paste(window, (PAD, PAD), Image.composite(mask, Image.new("L", mask.size, 0), window.split()[3]))
        frames.append(page.convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
        durations.append(gif.info.get("duration", 100))
    frames[0].save(
        out_path,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )
    print(out_path, f"{out_path.stat().st_size // 1024} KB", f"{len(frames)} frames")
