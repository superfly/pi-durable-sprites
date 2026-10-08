"""Put a terminal recording GIF (from agg) inside a window: title bar, rounded corners, drop shadow.

GitHub strips CSS from READMEs, so the chrome is baked into the frames. The page around the window is transparent, with
the shadow as real alpha, so one file works on any background. That needs animated WebP: GIF has no alpha, only 1-bit
transparency. A light-background GIF is written too, for viewers without WebP; the README offers it through <picture>.

    python3 -I demos/frame.py /tmp/raw.gif demos/pi-durable-sprites.webp demos/pi-durable-sprites.gif

Needs Pillow with WebP support (`pip install pillow`).
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

source, webp_out, gif_out = (Path(arg) for arg in sys.argv[1:4])

RADIUS = 12
BAR = 40
PAD = 48  # room for the shadow
SHADOW_OFFSET = (0, 18)
SHADOW_BLUR = 22
SHADOW = (0, 0, 0, 110)
TITLE = "pi-durable-sprites — demo"
TERMINAL_BG = (0x17, 0x14, 0x34)  # the agg theme's background, so the chrome and the frames join seamlessly
BAR_BG = (0x24, 0x20, 0x45)
TITLE_COLOR = (0xA3, 0x9A, 0xC1)
LIGHTS = [(0xFF, 0x5F, 0x57), (0xFE, 0xBC, 0x2E), (0x28, 0xC8, 0x40)]
GIF_PAGE = (0xFF, 0xFF, 0xFF)

font_dir = Path.home() / ".local/share/fonts/fonts/ttf"
try:
    font = ImageFont.truetype(str(font_dir / "JetBrainsMono-Medium.ttf"), 14)
except OSError:
    font = ImageFont.load_default()

gif = Image.open(source)
width, height = gif.size
window_w, window_h = width, height + BAR
canvas_w, canvas_h = window_w + 2 * PAD, window_h + 2 * PAD
x0, y0 = PAD, PAD

mask = Image.new("L", (window_w, window_h), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, window_w - 1, window_h - 1), RADIUS, fill=255)

# The transparent page with the shadow, and the window's title bar; the terminal area is filled by each frame.
page = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
shadow = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
dx, dy = SHADOW_OFFSET
ImageDraw.Draw(shadow).rounded_rectangle((x0 + dx, y0 + dy, x0 + window_w + dx, y0 + window_h + dy), RADIUS, fill=SHADOW)
page = Image.alpha_composite(page, shadow.filter(ImageFilter.GaussianBlur(SHADOW_BLUR)))
window = Image.new("RGBA", (window_w, window_h), TERMINAL_BG + (255,))
draw = ImageDraw.Draw(window)
draw.rectangle((0, 0, window_w, BAR), fill=BAR_BG)
for index, color in enumerate(LIGHTS):
    cx = 20 + index * 22
    draw.ellipse((cx - 6, BAR / 2 - 6, cx + 6, BAR / 2 + 6), fill=color)
text_w = draw.textlength(TITLE, font=font)
draw.text(((window_w - text_w) / 2, BAR / 2 - 9), TITLE, font=font, fill=TITLE_COLOR)
page.paste(window, (x0, y0), mask)

frames, durations = [], []
for index in range(gif.n_frames):
    gif.seek(index)
    frame = gif.convert("RGBA")
    composed = page.copy()
    # The frame sits below the title bar; the window mask rounds its bottom corners.
    inner = Image.new("RGBA", (window_w, window_h), (0, 0, 0, 0))
    inner.paste(frame, (0, BAR))
    composed.paste(inner, (x0, y0), Image.composite(mask, Image.new("L", mask.size, 0), inner.split()[3]))
    frames.append(composed)
    durations.append(gif.info.get("duration", 100))

# Flat terminal colors compress well losslessly, and lossless keeps the text crisp.
frames[0].save(webp_out, save_all=True, append_images=frames[1:], duration=durations, loop=0, lossless=True, quality=100, method=6)
print(webp_out, f"{webp_out.stat().st_size // 1024} KB", f"{len(frames)} frames")

flat = []
for frame in frames:
    on_page = Image.new("RGBA", frame.size, GIF_PAGE + (255,))
    on_page.alpha_composite(frame)
    flat.append(on_page.convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
flat[0].save(gif_out, save_all=True, append_images=flat[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(gif_out, f"{gif_out.stat().st_size // 1024} KB")
