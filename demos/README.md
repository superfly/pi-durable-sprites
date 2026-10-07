# Demo

`demo.ts` runs a real model against a fresh Sprite through Pi Durable, kills the harness halfway, resumes it from the
same SQLite file, checks the result through the Sprites API and deletes the Sprite. It needs `SPRITES_TOKEN` and
`ANTHROPIC_API_KEY`; `DEMO_MODEL` picks the model (default `claude-sonnet-5-5`).

```sh
npm run demo
```

## Recording

`pi-durable-sprites.cast` is an [asciinema](https://asciinema.org) recording of the script. The GIFs in the README are
rendered from it with [agg](https://github.com/asciinema/agg), then framed as a terminal window with a drop shadow by
`frame.py` (Pillow). GitHub strips CSS from READMEs, so the window and shadow are baked into the frames, once for the
light theme and once for the dark one.

```sh
# 1. Record (100 columns, 42 rows, pauses capped at 2.5 s).
asciinema rec --cols 100 --rows 42 -i 2.5 -c "node demos/demo.ts" demos/pi-durable-sprites.cast

# 2. Render the raw GIF. JetBrains Mono, on the Fly.io peacoat background.
agg --font-family "JetBrains Mono" --font-size 16 --speed 1.15 --last-frame-duration 4 \
  --theme 171434,f4f3fb,171434,ff5c57,5af78e,f3f99d,57c7ff,ff6ac1,9aedfe,f1f1f0,686868,ff5c57,5af78e,f3f99d,57c7ff,ff6ac1,9aedfe,eff0eb \
  demos/pi-durable-sprites.cast /tmp/raw.gif

# 3. Frame it for both GitHub themes.
python3 -I demos/frame.py /tmp/raw.gif demos/pi-durable-sprites-light.gif demos/pi-durable-sprites-dark.gif
```

Before committing a new cast, check it holds no secrets: `grep -c "sk-ant\|SPRITES_TOKEN" demos/*.cast` should print 0.
