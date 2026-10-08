# AGENTS.md

Guidance for coding agents working in this repository. Humans: the README and `docs/` are written for you.

## What this is

`@fly/pi-durable-sprites` makes [Pi Durable](https://earendil.com/posts/pi-durable/) run each conversation's tools
(read, write, edit, bash) inside its own [Fly.io Sprite](https://sprites.dev). It does this by running pi-env, Pi's
remote execution daemon, in the Sprite over a Sprites exec WebSocket. An optional extension adds Sprite checkpoints,
services and the URL as tools. Read [docs/how-it-works.md](docs/how-it-works.md) before changing anything in `src/`.

## Layout

| Path | |
|---|---|
| `src/connection.ts` | **A copy** of pi-env's `Connection` with a pluggable transport and an idle timeout. See its header. |
| `src/transport.ts` | Uploads the daemon into a Sprite (named by SHA-256, verified before every start) and starts it over exec. |
| `src/env.ts` | `SpritesExecutionEnv` (extends pi-env's `RemoteExecutionEnv`) and `connectSprite()`. |
| `src/pool.ts` | `SpritesEnvPool`: one connection per Sprite, for the Harness `env` function. |
| `src/extension.ts` | `createSpritesExtension()`: the `sprite_*` tools and the system prompt section. |
| `test/` | Vitest. Every file creates a real Sprite and deletes it in `afterAll`. |
| `examples/` | Two conversations in two Sprites with a scripted (faux) model. |
| `demos/` | The recorded demo, its script and the rendering pipeline. |
| `docs/` | Usage, how it works, testing. |

## Commands

```sh
npm run lint                        # biome: lint and format check; `npm run format` applies the fixes
npm run check                       # tsc over src, test, examples and demos
npm test                            # needs SPRITES_TOKEN; about 12 s against real Sprites
npm run build                       # dist/
SPRITES_TOKEN=... node examples/sprite-per-conversation.ts
SPRITES_TOKEN=... ANTHROPIC_API_KEY=... npm run demo
```

Node 24 runs the TypeScript directly; there is no transpile step for tests, examples or demos.

## Rules

- **Tests use real Sprites and cost real money and time.** Each test file creates a Sprite named `pi-durable-<label>-<hex>`
  and deletes it in `afterAll`. If a run is interrupted, delete leftovers: list Sprites with the `pi-durable-` and
  `pi-demo-` prefixes and remove them, but only when no other run is in progress on the same account; deleting by
  prefix kills a concurrent run's Sprites too. Never run the suite without `SPRITES_TOKEN` expecting it to test anything; it
  skips.
- **The end-to-end test and the demo call a real model.** They need `ANTHROPIC_API_KEY` and are skipped without it.
  Do not run them in a loop.
- **`src/connection.ts` must stay in step with upstream.** It is pi-env's `packages/env/src/connection.ts` at the
  commit named in its header, with exactly two changes (the transport and the idle timeout). When bumping
  `@earendil-works/pi-env`, diff the new upstream file against ours and port changes; do not refactor it. The dependency
  is pinned `~1.1.0` because `RemoteExecutionEnv` relies on the frame protocol and timings.
- **Never commit a secret.** `demos/*.cast` is a terminal recording; before committing a new one, run
  `grep -c "sk-ant\|SPRITES_TOKEN" demos/*.cast` and expect `0`. Tokens live in the environment only.
- **Don't delete the daemon's semantics to simplify.** Output windows, spill files, per-command kill, byte-range reads
  and inotify watches all happen inside the Sprite on purpose; the conformance suite (`test/conformance.test.ts`, 48
  cases, native and polling) must keep passing.
- **A pooled environment's `close()` is a no-op by design.** Environments from `SpritesEnvPool` share one connection;
  release a Sprite through `pool.release(name)`. There is a regression test for this.
- **`sprite_url` must not let the model make a URL public unless `allowPublicUrl: true`.** The check is in the tool's
  code, not only its schema. There is a test for this too.

## Style

- TypeScript, tabs, `verbatimModuleSyntax`, `.ts` extensions in imports. Biome lints and formats (`biome.json`); CI
  runs `npm run lint`, `npm run check` and `npm run build`, and nothing that needs a token.
- Comments say why, not what, and are full sentences. Keep the density of the file you are in.
- Errors follow Pi Durable's `Result` convention in `src/`; tools in `src/extension.ts` throw, which Pi turns into an
  error result for the model.
- `pi-env`'s remote semantics are the reference. If `SpritesExecutionEnv` behaves differently from `NodeExecutionEnv`
  running inside the Sprite, that is a bug.

## Before you finish

1. `npm run lint` and `npm run check` pass.
2. `SPRITES_TOKEN=... npm test` passes, and no `pi-durable-*` or `pi-demo-*` Sprites are left on the account.
3. If you changed `demos/demo.ts`, re-record and re-render it ([demos/README.md](demos/README.md)) and check the cast
   for secrets.
4. If you changed behaviour, update `docs/`.
