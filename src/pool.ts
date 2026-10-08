import type { Sprite, SpritesClient } from "@fly/sprites";
import type { DaemonConnection } from "./connection.ts";
import {
	connectSprite,
	type SpriteConnectionOptions,
	SpritesExecutionEnv,
	type SpritesExecutionEnvOptions,
} from "./env.ts";

export interface SpritesEnvPoolOptions extends SpriteConnectionOptions {
	client: SpritesClient;
	/** Working directory when the caller gives none; default `/home/sprite`. */
	cwd?: string;
	shellPath?: string;
	shellEnv?: Record<string, string>;
	watch?: SpritesExecutionEnvOptions["watch"];
}

/**
 * Environments for many Sprites, with one daemon connection per Sprite. Pi Durable builds an environment for every
 * tool call; `env()` is cheap and reuses the Sprite's connection, so it fits `HarnessOptions.env` directly:
 *
 * ```ts
 * const sprites = new SpritesEnvPool({ client });
 * env: async ({ conversationId, read, cwd }, ctx) => {
 *   const name = (await read.snapshot(SpriteDoc, conversationId, ctx))?.name;
 *   return name === undefined ? undefined : sprites.env(name, { cwd });
 * }
 * ```
 */
export class SpritesEnvPool {
	readonly #options: SpritesEnvPoolOptions;
	readonly #connections = new Map<string, DaemonConnection>();

	constructor(options: SpritesEnvPoolOptions) {
		this.#options = options;
	}

	/** An environment in the Sprite named `name`. Connecting waits until the first operation. */
	env(name: string, options: { cwd?: string | undefined } = {}): SpritesExecutionEnv {
		const sprite = this.sprite(name);
		let connection = this.#connections.get(name);
		if (connection === undefined) {
			connection = connectSprite(sprite, this.#options);
			this.#connections.set(name, connection);
		}
		const { shellPath, shellEnv, watch } = this.#options;
		return new SpritesExecutionEnv({
			sprite,
			connection,
			...((options.cwd ?? this.#options.cwd) === undefined ? {} : { cwd: options.cwd ?? this.#options.cwd }),
			...(shellPath === undefined ? {} : { shellPath }),
			...(shellEnv === undefined ? {} : { shellEnv }),
			...(watch === undefined ? {} : { watch }),
		});
	}

	/** The SDK handle of a Sprite, for its checkpoints, services and URL. */
	sprite(name: string): Sprite {
		return this.#options.client.sprite(name);
	}

	/** Stop the daemon of one Sprite, for example before deleting it. */
	release(name: string): void {
		this.#connections.get(name)?.close();
		this.#connections.delete(name);
	}

	/** Stop every daemon; for the host's shutdown. */
	close(): void {
		for (const connection of this.#connections.values()) connection.close();
		this.#connections.clear();
	}
}
