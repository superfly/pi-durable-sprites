import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { packagedDaemon } from "@earendil-works/pi-env";
import type { Sprite } from "@fly/sprites";
import type { DaemonProcess } from "./connection.ts";

/** A pi-env daemon build for one Linux architecture. */
interface DaemonBuild {
	bytes: Buffer;
	sha256: string;
}

type Arch = "x64" | "arm64";

/** How long a daemon whose stdin ended may take to exit before its WebSocket is closed. */
const KILL_GRACE_MS = 2000;

let builds: Promise<Record<Arch, DaemonBuild>> | undefined;

/** The daemons the installed `@earendil-works/pi-env` ships for Linux, read and hashed once per process. */
function packagedBuilds(): Promise<Record<Arch, DaemonBuild>> {
	builds ??= (async () => {
		const read = async (arch: Arch): Promise<DaemonBuild> => {
			const bytes = await readFile(packagedDaemon({ platform: "linux", arch }));
			return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
		};
		const [x64, arm64] = await Promise.all([read("x64"), read("arm64")]);
		return { x64, arm64 };
	})();
	builds.catch(() => {
		builds = undefined;
	});
	return builds;
}

/**
 * Finds the daemon in the Sprite. It is named by its SHA-256 below `$HOME/.pi/env`, so versions never collide, and its
 * content is verified before every start. Prints `present|missing <arch> <path>`, or `unsupported <machine>`.
 */
const PROBE = `case "$(uname -m)" in
x86_64|amd64) a=x64 s=$1 ;;
aarch64|arm64) a=arm64 s=$2 ;;
*) echo "unsupported $(uname -m)"; exit 0 ;;
esac
f="$HOME/.pi/env/pi-env-$(printf %s "$s" | cut -c1-32)"
if [ "$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)" = "$s" ]; then echo "present $a $f"; else echo "missing $a $f"; fi`;

/** Moves an uploaded daemon into place only if its content is intact. */
const INSTALL = `[ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ] || { rm -f "$1"; echo "pi-env upload is corrupt" >&2; exit 1; }
mv -f "$1" "$3"`;

async function run(sprite: Sprite, script: string, args: readonly string[]): Promise<string> {
	const result = await sprite.execFile("sh", ["-c", script, "sh", ...args]);
	return String(result.stdout).trim();
}

/** Make sure the Sprite has the packaged daemon for its architecture, uploading it if needed, and return its path. */
export async function deployDaemon(sprite: Sprite): Promise<string> {
	const daemons = await packagedBuilds();
	const probe = await run(sprite, PROBE, [daemons.x64.sha256, daemons.arm64.sha256]);
	const [state, arch, file] = probe.split(" ", 3);
	if (state === "present" && file) return file;
	if (state !== "missing" || (arch !== "x64" && arch !== "arm64") || !file) {
		throw new Error(`Cannot run pi-env in Sprite ${sprite.name}: ${probe || "no answer from probe"}`);
	}
	const build = daemons[arch];
	const dir = file.slice(0, file.lastIndexOf("/"));
	const upload = `${dir}/.pi-env-${randomUUID()}.tmp`;
	const fs = sprite.filesystem("/");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(upload, build.bytes, { mode: 0o755 });
	await run(sprite, INSTALL, [upload, build.sha256, file]);
	return file;
}

/**
 * Start the daemon in the Sprite over a Sprites exec WebSocket. The end of stdin stops the daemon, which kills every
 * command it started; `kill()` ends stdin, and closes the WebSocket if the daemon does not exit within two seconds.
 */
export async function openDaemon(sprite: Sprite, token: string): Promise<DaemonProcess> {
	const file = await deployDaemon(sprite);
	const command = sprite.spawn(file, ["serve", "--token", token]);
	await new Promise<void>((resolve, reject) => {
		command.once("spawn", resolve);
		command.once("error", reject);
	});
	return {
		stdin: command.stdin,
		stdout: command.stdout,
		stderr: command.stderr,
		on: (event: "exit" | "error", listener: (value: any) => void) => command.on(event, listener),
		once: (event: "exit" | "error", listener: (value: any) => void) => command.once(event, listener),
		kill: () => {
			// The end of stdin stops the daemon. Closing the WebSocket at once could drop that EOF frame, and the Sprite
			// would keep the daemon running for a while after the disconnect, so close only if it does not exit soon.
			command.stdin.end();
			const timer = setTimeout(() => command.close(), KILL_GRACE_MS);
			timer.unref();
			command.once("exit", () => clearTimeout(timer));
		},
	};
}
