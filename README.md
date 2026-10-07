<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/fly-pi-lockup-dark.svg">
    <img alt="Fly.io and Pi" src="assets/fly-pi-lockup-light.svg" width="320">
  </picture>
</p>

# @fly/pi-durable-sprites

Give every AI agent conversation its own computer.

[Pi Durable](https://earendil.com/posts/pi-durable/) runs long AI agent conversations. When the agent reads a file,
edits code or runs a command, it does that through a pluggable "execution environment". By default, that is the
machine Pi Durable itself runs on.

This package makes that environment a [Fly.io Sprite](https://sprites.dev) instead: a small, persistent Linux VM. Each
conversation gets its own Sprite, so:

- **The agent can do real work.** It has a full shell: it can install packages, run tests, start servers and use the
  network.
- **Conversations are isolated.** One conversation's files and processes never touch another's, or your server.
- **Work is kept.** A Sprite keeps its files when it sleeps, and it can take checkpoints to roll back to.
- **Nothing else moves.** Pi Durable, its storage and your model API keys stay where they are. Only the agent's tools run
  in the Sprite.

You give Pi Durable a function that names the Sprite for each conversation. This package does the rest: it connects to
that Sprite and runs every file operation and command there.

## What's in the package

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

```sh
npm install @fly/pi-durable-sprites @earendil-works/pi-durable @fly/sprites
```

## One Sprite per conversation

Record each conversation's Sprite in a conversation document and look it up in `env`, which the Harness calls for every
tool call. `sprites.env()` is cheap: it reuses the Sprite's connection.

```ts
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { SpritesClient } from "@fly/sprites";
import { createSpritesExtension, SpritesEnvPool } from "@fly/pi-durable-sprites";

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

[`examples/sprite-per-conversation.ts`](examples/sprite-per-conversation.ts) runs two conversations in two Sprites with a
scripted model; each writes `note.txt` only in its own Sprite:

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

## One environment

```ts
import { SpritesExecutionEnv } from "@fly/pi-durable-sprites";

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

## How it works

Pi Durable already has a remote execution environment: [pi-env](https://github.com/earendil-works/pi/tree/main/packages/env),
a small daemon that runs next to the files and speaks a framed protocol on stdin and stdout, and `RemoteExecutionEnv`,
its client. Its results match `NodeExecutionEnv` running on the remote machine. This package runs that daemon in the
Sprite and carries its stdin and stdout over a [Sprites exec](https://docs.sprites.dev) WebSocket instead of SSH:

```
Pi Durable harness ── RemoteExecutionEnv ── DaemonConnection ══ Sprites exec WebSocket ══ pi-env daemon (in the Sprite)
                                                                                         ├─ files: open, pread, write, rename, readdir, ...
                                                                                         ├─ exec: bash, per-command kill, timeout, spill, window
                                                                                         └─ watch: inotify (or polling)
```

So the Sprite gets everything the issue list asked for, computed next to the files instead of over the network:

- **`window`**: the daemon keeps only the tail Pi Durable asks for and reports the rest as `skipped`, so a command that
  prints megabytes sends only what the model will see.
- **Abort and timeout** kill only that command's process group. `cleanup()` kills every command of that environment.
- **`watch()`** uses inotify in the Sprite (`mode: "native"`), or snapshots with `watch: { mode: "polling" }`.
- **`openBinaryReader()`, `scanLines()`** read byte ranges and scan lines in the Sprite.
- **Spills**: over-long output goes to a temporary file in the Sprite, which the `read` tool can page through.

The daemon (≈1.2 MB, the build `@earendil-works/pi-env` ships for Linux x86-64 and arm64) is uploaded on first use
through the Sprites filesystem API to `~/.pi/env/pi-env-<sha256>`, and its SHA-256 is verified before every start.
The connection starts it on the first operation, starts it again after the WebSocket is lost (a restore, a network
blip), and stops it after `idleTimeoutMs` without requests or open handles, so an idle conversation does not keep its
Sprite awake. Open watches keep it running.

`DaemonConnection` is pi-env's `Connection` with a pluggable transport (see the header of
[`src/connection.ts`](src/connection.ts)); `@earendil-works/pi-env` is pinned to `~1.1.0` to keep the frame protocol in
step.

## Tests

The tests run against real Sprites; each file creates its own Sprite and deletes it afterwards.

```sh
SPRITES_TOKEN=... npm test
```

- `test/conformance.test.ts`: Pi Durable's `registerEnvConformance()` suite, with native and with polling watches.
- `test/sprites.test.ts`: deployment, per-command abort, idle stop and restart, restart after the daemon dies, no
  daemon left after `close()`.
- `test/extension.test.ts`: the extension through a Harness: system prompt, checkpoint and restore, services, URL.
- `test/e2e.test.ts`: end to end with a real model. It is told to run `seq 1 20000` (the output window), write a Node
  HTTP server, run it as a service, call it, and checkpoint; the test then checks each result through the Sprites API.
  Needs `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` routes through a proxy and `E2E_MODEL` picks the model (default
  `claude-sonnet-5-5`). About 20 seconds and a few cents.

Without `SPRITES_TOKEN` they are skipped, and the end-to-end test also without `ANTHROPIC_API_KEY`.

## Future work

Pi Durable can fork a conversation. When Sprites can fork a Sprite, a conversation fork can fork its Sprite's file system
too; until then a fork starts without a Sprite (`fork: "initial"` above) and the app assigns one.

## License

MIT
