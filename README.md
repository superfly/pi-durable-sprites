<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/fly-pi-lockup-dark.svg">
    <img alt="Fly.io and Pi" src="assets/fly-pi-lockup-light.svg" width="320">
  </picture>
</p>

# @fly/pi-durable-sprites

Give every AI agent conversation its own computer.

[Pi Durable](https://earendil.com/posts/pi-durable/) runs long agent conversations and checkpoints every step. This
package makes each conversation's tools run in its own [Fly.io Sprite](https://sprites.dev): a persistent Linux VM with a
real shell, packages and network. The agent's files and processes never touch your server or another conversation's,
the Sprite keeps its state when it sleeps, and Pi Durable, its storage and your model keys stay where they are.

<p align="center">
  <picture>
    <source type="image/webp" srcset="demos/pi-durable-sprites.webp">
    <img alt="Terminal recording of the demo" src="demos/pi-durable-sprites.gif" width="860">
  </picture>
</p>

<p align="center"><sub>A real model builds a service in a fresh Sprite. Halfway through, the harness is killed with
SIGKILL; a new process resumes from the same SQLite file and the Sprite still has everything. <a href="demos/">How to
run it.</a></sub></p>

## Install

```sh
npm install @fly/pi-durable-sprites @earendil-works/pi-durable @fly/sprites
```

## Use

Two parts. **The environment** is required: it moves the agent's own read, write, edit and bash tools into the Sprite.
**The extension** is optional: it adds Sprite checkpoints, services and the URL as tools, and tells the model where it
works.

```ts
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { SpritesClient } from "@fly/sprites";
import { createSpritesExtension, SpritesEnvPool } from "@fly/pi-durable-sprites";

const sprites = new SpritesEnvPool({ client: new SpritesClient(process.env.SPRITES_TOKEN!) });
const SpriteDoc = defineDoc<{ name?: string }>({ kind: "app.sprite", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}) });

const registry = createRegistry();
registry.install(CodingTools);
registry.install(createSpritesExtension());

const harness = await Harness.open(storage, {
	models,
	registry,
	// Called for every tool call: look up the conversation's Sprite and run the tool there.
	env: async ({ conversationId, cwd, read }, ctx) => {
		const name = (await read.snapshot(SpriteDoc, conversationId, ctx))?.name;
		return name === undefined ? undefined : sprites.env(name, { cwd });
	},
}, context);
```

A new conversation gets a new Sprite, recorded in its `SpriteDoc` when it is created. The full version, with the
per-conversation setup and a single-environment variant, is in [docs/usage.md](docs/usage.md).

## Docs

- [Usage](docs/usage.md): one Sprite per conversation, one environment, options, the extension's tools.
- [How it works](docs/how-it-works.md): pi-env over a Sprites exec WebSocket, daemon lifecycle, what runs where.
- [Testing](docs/testing.md): the conformance, integration and end-to-end suites, and how to run them.
- [Demo](demos/README.md): the recording and how to reproduce it.

## License

MIT
