# How it works

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

## What runs where

Only the agent's tools run in the Sprite. The harness, its storage (SQLite or JSONL), the model credentials and the
model calls themselves stay on the host. The Sprite sees commands and files, never the conversation or the keys.

Everything Pi Durable's tools need is computed next to the files instead of over the network:

- **`window`**: the daemon keeps only the tail Pi Durable asks for and reports the rest as `skipped`, so a command that
  prints megabytes sends only what the model will see.
- **Abort and timeout** kill only that command's process group. `cleanup()` kills every command of that environment.
- **`watch()`** uses inotify in the Sprite (`mode: "native"`), or snapshots with `watch: { mode: "polling" }`.
- **`openBinaryReader()`, `scanLines()`** read byte ranges and scan lines in the Sprite.
- **Spills**: over-long output goes to a temporary file in the Sprite, which the `read` tool can page through.

## Daemon lifecycle

The daemon (≈1.2 MB, the build `@earendil-works/pi-env` ships for Linux x86-64 and arm64) is uploaded on first use
through the Sprites filesystem API to `~/.pi/env/pi-env-<sha256>`, and its SHA-256 is verified before every start.

The connection starts it on the first operation, starts it again after the WebSocket is lost (a Sprite restore, a
network blip), and stops it after `idleTimeoutMs` without requests or open handles, so an idle conversation does not
keep its Sprite awake. Open watches keep it running. Stopping it is the end of its stdin, which makes the daemon kill
every command it started and exit; the WebSocket is closed only if the daemon has not exited within two seconds.

## Why not the Sprites exec and filesystem APIs directly

Every item above needs code running inside the Sprite: output windows, spill files, per-command kill, byte-range reads
and file watching cannot be done from the outside through an exec-per-call API. A native implementation would still need
a helper program in the Sprite, and that helper would have none of pi-env's testing. pi-env is tested upstream against
the same conformance suite this package runs, and by comparing random operation sequences against Pi's local
environment, which is why the suite passed on the first run here.

The cost is a binary in each Sprite, Linux only, and one copied class: `DaemonConnection` is pi-env's `Connection` with a
pluggable transport (see the header of [`src/connection.ts`](../src/connection.ts)). `@earendil-works/pi-env` is
pinned to `~1.1.0` to keep the frame protocol in step; a small upstream change letting `Connection` accept a transport
would remove the copy.
