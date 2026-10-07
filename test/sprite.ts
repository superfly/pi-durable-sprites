import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { type Sprite, SpritesClient } from "@fly/sprites";
import { type SpritesExecutionEnv, SpritesEnvPool, type SpritesEnvPoolOptions } from "../src/index.ts";

/** Integration tests need a Sprites API token; without one they are skipped. */
export const token = process.env.SPRITES_TOKEN;
export const client = token === undefined ? undefined : new SpritesClient(token);

/** A fresh Sprite for one test file, created on first use; `destroy()` deletes it. */
export function testSprite(label: string) {
	const name = `pi-durable-${label}-${randomBytes(4).toString("hex")}`;
	let created: Promise<Sprite> | undefined;
	return {
		name,
		get(): Promise<Sprite> {
			if (client === undefined) throw new Error("SPRITES_TOKEN is not set");
			created ??= client.createSprite(name);
			return created;
		},
		async destroy(): Promise<void> {
			if (created === undefined || client === undefined) return;
			await (await created).delete().catch(() => undefined);
		},
	};
}

/** Calls `use` with an environment whose `cwd` is a fresh, empty directory in the Sprite, then removes it. */
export async function inFreshDir(
	pool: SpritesEnvPool,
	name: string,
	use: (env: SpritesExecutionEnv) => Promise<void>,
): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const base = pool.env(name);
	const cwd = getOrThrow(await base.createTempDir("pi-durable-conformance-", context));
	try {
		await use(pool.env(name, { cwd }));
	} finally {
		await base.remove(cwd, { recursive: true, force: true }, context);
	}
}

export function pool(options: Omit<SpritesEnvPoolOptions, "client"> = {}): SpritesEnvPool {
	if (client === undefined) throw new Error("SPRITES_TOKEN is not set");
	return new SpritesEnvPool({ client, ...options });
}
