import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import { inFreshDir, pool, testSprite, token } from "./sprite.ts";

// Pi Durable's ExecutionEnv conformance suite, run against a real Sprite, once with native (inotify) watches and once
// with polling watches.
const sprite = testSprite("conformance");
const native = token === undefined ? undefined : pool();
const polling = token === undefined ? undefined : pool({ watch: { mode: "polling", pollIntervalMs: 100 } });

afterAll(async () => {
	native?.close();
	polling?.close();
	await sprite.destroy();
});

const suite = token === undefined ? describe.skip : describe;
const runner = { describe: suite, expect, it } as Parameters<typeof registerEnvConformance>[0];

registerEnvConformance(runner, "SpritesExecutionEnv conformance", async (use) => {
	await sprite.get();
	await inFreshDir(native!, sprite.name, use);
});

registerEnvConformance(runner, "SpritesExecutionEnv conformance with polling watches", async (use) => {
	await sprite.get();
	await inFreshDir(polling!, sprite.name, use);
});
