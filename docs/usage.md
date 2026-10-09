# Usage

The package does two different jobs.

**The environment** (required) decides *where* the agent's work happens. When the agent reads a file, edits code or runs
a command, it happens inside the conversation's Sprite instead of on your server. The agent doesn't know or care: its
normal tools (read, write, edit, bash) just work there.

**The extension** (optional) adds things the agent can *do* only because it's on a Sprite:

- New tools the model can call: save a checkpoint, roll back to one, run a server as a service, get the Sprite's URL.
- A note in the system prompt telling the model it's working in a Sprite, and how to use it well.

Without the extension, the agent still works in the Sprite; it just doesn't know it's there or use those features. The
environment gives the agent a computer; the extension teaches the agent what that computer can do.

In code:

- **`SpritesExecutionEnv`**: a Pi Durable `ExecutionEnv` whose files and commands live in one Sprite. It passes Pi
  Durable's `ExecutionEnv` conformance suite against a real Sprite, with native and with polling watches.
- **`SpritesEnvPool`**: environments for many Sprites with one connection per Sprite, made for the Harness `env`
  function: one Sprite per conversation.
- **`createSpritesExtension()`** (optional): tools for the conversation's Sprite (checkpoints, restore, services, its URL)
  and a system prompt section that tells the model where it works.

## One Sprite per conversation

Record each conversation's Sprite in a conversation document and look it up in `env`, which the Harness calls for every
tool call. `sprites.env()` is cheap: it reuses the Sprite's connection.

```ts
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { SpritesClient } from "@fly/sprites";
import { createSpritesExtension, SpritesEnvPool } from "@flydotio/pi-durable-sprites";

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprites = new SpritesEnvPool({ client });

const SpriteDoc = defineDoc<{ name?: string }>({
	kind: "app.sprite",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial", // a fork gets no Sprite until the app assigns one
	initial: () => ({}),
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(createSpritesExtension());

const harness = await Harness.open(storage, {
	models,
	registry,
	env: async ({ conversationId, cwd, read }, ctx) => {
		const name = (await read.snapshot(SpriteDoc, conversationId, ctx))?.name;
		return name === undefined ? undefined : sprites.env(name, { cwd });
	},
}, context);

// A new conversation gets a new Sprite, recorded in the creating commit.
const name = `chat-${crypto.randomUUID()}`;
await client.createSprite(name);
const conversation = await harness.createConversation({
	ownership: { kind: "ownerless" },
	agent: { model },
	init: async (tx, id) => {
		(await tx.doc(SpriteDoc, id)).name = name;
	},
}, context);
```

[`examples/sprite-per-conversation.ts`](../examples/sprite-per-conversation.ts) runs two conversations in two Sprites
with a scripted model; each writes `note.txt` only in its own Sprite:

```console
$ SPRITES_TOKEN=... node examples/sprite-per-conversation.ts
--- pi-durable-example-alice-0f58c5: bash output
pi-durable-example-alice-0f58c5
/home/sprite
from alice
--- pi-durable-example-bob-6781a9: bash output
pi-durable-example-bob-6781a9
/home/sprite
from bob
pi-durable-example-alice-0f58c5: note.txt = "from alice\n"
pi-durable-example-bob-6781a9: note.txt = "from bob\n"
```

### Pool

| Method | |
|---|---|
| `env(name, { cwd })` | An environment in the Sprite named `name`; connecting waits until the first operation. |
| `sprite(name)` | The `@fly/sprites` handle, for checkpoints, services and the URL. |
| `release(name)` | Stop that Sprite's daemon, for example before deleting the Sprite. |
| `close()` | Stop every daemon; for the host's shutdown. |

Environments from a pool share the Sprite's connection, so `env.close()` on one of them does nothing; release the
Sprite through the pool.

## One environment

```ts
import { SpritesExecutionEnv } from "@flydotio/pi-durable-sprites";

const env = new SpritesExecutionEnv({ sprite: client.sprite("my-sprite"), cwd: "/home/sprite/project" });
await env.exec("npm test", { onOutput: (text) => process.stdout.write(text) }, context);
env.close();
```

| Option | Default | |
|---|---|---|
| `sprite` | | The `@fly/sprites` handle. |
| `cwd` | `/home/sprite` | Where commands start and relative paths resolve. |
| `id` | `sprites:<name>` | The file namespace; Pi Durable serializes writes to one file by `id` and path. |
| `idleTimeoutMs` | `60000` | Stop the daemon after this long without work, so the Sprite can sleep. `0`: never. |
| `watch` | native | `{ mode: "polling", pollIntervalMs }` to poll instead of inotify. |
| `shellPath`, `shellEnv` | bash | As for Pi Durable's `NodeExecutionEnv`. |
| `connection` | new | Share one `connectSprite(sprite)` between environments of the same Sprite. |

## Sprites extension

`createSpritesExtension()` adds tools that act on the Sprite of the call's environment:

| Tool | |
|---|---|
| `sprite_checkpoint` | Checkpoint the whole Sprite (files, packages, services). |
| `sprite_checkpoints` | List checkpoints. |
| `sprite_restore` | Restore a checkpoint. |
| `sprite_service` | List, create, start, stop, restart, read logs of and delete services: processes the Sprite restarts when it wakes. A service with `http_port` receives the Sprite URL's requests. |
| `sprite_url` | Show the Sprite's URL and its auth mode. With `createSpritesExtension({ allowPublicUrl: true })` the model may also make it public. |

Its `sprite` system prompt section tells the model it works in a Sprite, that processes started from bash stop when the
Sprite sleeps, and where its URL points. In conversations whose environment is not a `SpritesExecutionEnv`, the section
renders nothing and the tools fail.

## Future work

Pi Durable can fork a conversation. When Sprites can fork a Sprite, a conversation fork can fork its Sprite's file system
too; until then a fork starts without a Sprite (`fork: "initial"` above) and the app assigns one.
