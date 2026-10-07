import { type Connection, RemoteExecutionEnv, type RemoteWatchOptions } from "@earendil-works/pi-env";
import type { Sprite } from "@fly/sprites";
import { DaemonConnection } from "./connection.ts";
import { openDaemon } from "./transport.ts";

/** Where commands start and relative paths resolve when no `cwd` is given: the home of the Sprite's default user. */
export const DEFAULT_CWD = "/home/sprite";
/** How long a daemon stays up with nothing to do, so the Sprite can go to sleep. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface SpriteConnectionOptions {
	/** Stop the daemon after this long without work; it starts again on the next operation. 0: never. Default 60 s. */
	idleTimeoutMs?: number;
	/** Receives the daemon's and the transport's diagnostic output. */
	onLog?: (text: string) => void;
}

/**
 * The connection to the pi-env daemon in one Sprite. It deploys and starts the daemon on the first operation, starts it
 * again after the WebSocket is lost or the daemon was idle, and is shared by every environment of that Sprite.
 */
export function connectSprite(sprite: Sprite, options: SpriteConnectionOptions = {}): DaemonConnection {
	return new DaemonConnection({
		open: (token) => openDaemon(sprite, token),
		idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
		...(options.onLog === undefined ? {} : { onLog: options.onLog }),
	});
}

export interface SpritesExecutionEnvOptions extends SpriteConnectionOptions {
	sprite: Sprite;
	/** Default `/home/sprite`. */
	cwd?: string;
	/** The file namespace (`FileSystem.id`); default `sprites:<sprite name>`. */
	id?: string;
	/** A connection to share with other environments of the same Sprite; default a new one, see `connectSprite()`. */
	connection?: DaemonConnection;
	/** Shell for string commands; default bash, as `NodeExecutionEnv` picks it. */
	shellPath?: string;
	/** Added to the environment of every command that inherits it. */
	shellEnv?: Record<string, string>;
	/** How the daemon watches; native inotify by default. */
	watch?: RemoteWatchOptions;
}

/**
 * A Pi Durable `ExecutionEnv` whose files and commands are in a Fly.io Sprite. It runs pi-env, Pi's remote environment
 * daemon, in the Sprite over a Sprites exec WebSocket, so it behaves like `NodeExecutionEnv` running there: native file
 * watches, positional reads, output windows and spills computed next to the command, and abort or timeout killing only
 * that command.
 */
export class SpritesExecutionEnv extends RemoteExecutionEnv {
	readonly sprite: Sprite;
	readonly daemon: DaemonConnection;
	/** Whether this environment made its connection, so `close()` may stop it; a shared one belongs to its owner. */
	readonly #ownsConnection: boolean;

	constructor(options: SpritesExecutionEnvOptions) {
		const daemon = options.connection ?? connectSprite(options.sprite, options);
		const ownsConnection = options.connection === undefined;
		super({
			// `DaemonConnection` has `Connection`'s public interface; only its transport differs.
			connection: daemon as unknown as Connection,
			id: options.id ?? `sprites:${options.sprite.name}`,
			cwd: options.cwd ?? DEFAULT_CWD,
			...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
			...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
			...(options.watch === undefined ? {} : { watch: options.watch }),
		});
		this.sprite = options.sprite;
		this.daemon = daemon;
		this.#ownsConnection = ownsConnection;
	}

	/**
	 * Stop the daemon, which kills every command it still runs; the environment cannot be used afterwards. With a shared
	 * `connection`, such as one from `SpritesEnvPool`, this does nothing: close it through its owner (`pool.release()`).
	 */
	close(): void {
		if (this.#ownsConnection) this.daemon.close();
	}
}
