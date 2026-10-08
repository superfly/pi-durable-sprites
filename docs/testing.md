# Testing

The tests run against real Sprites; each file creates its own Sprite and deletes it afterwards. The whole suite takes
about 12 seconds, the end-to-end test another 20.

```sh
SPRITES_TOKEN=... npm test
```

| File | What it covers |
|---|---|
| `test/conformance.test.ts` | Pi Durable's `registerEnvConformance()` suite, with native and with polling watches: 48 cases. |
| `test/sprites.test.ts` | Deployment, per-command abort, idle stop and restart, restart after the daemon dies, pooled environments, no daemon left after `close()`. |
| `test/extension.test.ts` | The extension through a Harness: system prompt, checkpoint and restore, services, URL. |
| `test/e2e.test.ts` | End to end with a real model. It is told to run `seq 1 20000` (the output window), write a Node HTTP server, run it as a service, call it, and checkpoint; the test then checks each result through the Sprites API. |

Without `SPRITES_TOKEN` every test is skipped. The end-to-end test also needs `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL`
routes it through a proxy and `E2E_MODEL` picks the model (default `claude-sonnet-5-5`). It costs a few cents.

```sh
npm run lint    # biome: lint and format check
npm run check   # typecheck src, test, examples and demos
npm run build   # dist/
```

CI (`.github/workflows/ci.yml`) runs those three and checks the tarball's contents on every push and pull request. It
holds no secrets, so the Sprite tests are not part of it; run them locally before merging.
