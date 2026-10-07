import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { Sprite } from "@fly/sprites";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployDaemon, SpritesExecutionEnv } from "../src/index.ts";
import { testSprite, token } from "./sprite.ts";

const context = BACKGROUND_CONTEXT;
const fresh = testSprite("env");
let sprite: Sprite;

/** Daemons running in the Sprite, by their command lines. */
async function daemons(): Promise<string[]> {
	const result = await sprite.execFile("sh", ["-c", "pgrep -af '[p]i-env-.* serve' || true"]);
	return String(result.stdout)
		.split("\n")
		.filter((line) => line.trim() !== "");
}

async function until(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("Timed out");
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

describe.skipIf(token === undefined)("SpritesExecutionEnv in a real Sprite", () => {
	beforeAll(async () => {
		sprite = await fresh.get();
	});
	afterAll(() => fresh.destroy());

	it("deploys the daemon once, named by its hash, and reuses it", async () => {
		const first = await deployDaemon(sprite);
		expect(first).toMatch(/^\/home\/sprite\/\.pi\/env\/pi-env-[0-9a-f]{32}$/);
		expect(await deployDaemon(sprite)).toBe(first);
		const listing = await sprite.execFile("sh", ["-c", 'ls -a "$HOME/.pi/env"']);
		// No leftover uploads.
		expect(String(listing.stdout).split("\n").filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("replaces a daemon whose content changed", async () => {
		const file = await deployDaemon(sprite);
		await sprite.execFile("sh", ["-c", `printf corrupt > "${file}"`]);
		expect(await deployDaemon(sprite)).toBe(file);
		const env = new SpritesExecutionEnv({ sprite });
		try {
			expect(getOrThrow(await env.exec(["true"], undefined, context)).exitCode).toBe(0);
		} finally {
			env.close();
		}
	});

	it("works on the Sprite's files, not the host's", async () => {
		const env = new SpritesExecutionEnv({ sprite, cwd: "/tmp" });
		try {
			const marker = `written-by-env-${Date.now()}`;
			getOrThrow(await env.writeFile("/tmp/pi-durable-marker.txt", marker, context));
			const viaApi = await sprite.filesystem("/").readFile("/tmp/pi-durable-marker.txt", "utf8");
			expect(viaApi).toBe(marker);
			let hostname = "";
			getOrThrow(await env.exec("hostname", { onOutput: (text) => (hostname += text) }, context));
			const viaExec = await sprite.execFile("hostname");
			expect(hostname.trim()).toBe(String(viaExec.stdout).trim());
			expect(env.id).toBe(`sprites:${sprite.name}`);
		} finally {
			env.close();
		}
	});

	it("aborting one command kills only that command", async () => {
		const env = new SpritesExecutionEnv({ sprite, cwd: "/tmp" });
		try {
			const controller = new AbortController();
			const aborted = env.exec("sleep 30", undefined, withAbortSignal(controller.signal, context));
			let output = "";
			const kept = env.exec("sleep 1; echo survived", { onOutput: (text) => (output += text) }, context);
			setTimeout(() => controller.abort(), 200);
			expect(await aborted).toMatchObject({ ok: false, error: { code: "aborted" } });
			expect(getOrThrow(await kept).exitCode).toBe(0);
			expect(output).toBe("survived\n");
			const sleeping = await sprite.execFile("sh", ["-c", "pgrep -x sleep | wc -l"]);
			expect(String(sleeping.stdout).trim()).toBe("0");
		} finally {
			env.close();
		}
	});

	it("stops an idle daemon and starts it again on the next operation", async () => {
		const env = new SpritesExecutionEnv({ sprite, cwd: "/tmp", idleTimeoutMs: 500 });
		try {
			getOrThrow(await env.writeFile("idle.txt", "one", context));
			const before = await env.daemon.session();
			await until(async () => (await daemons()).length === 0);
			expect(getOrThrow(await env.readTextFile("idle.txt", context))).toBe("one");
			expect(await env.daemon.session()).not.toBe(before);
		} finally {
			env.close();
		}
	});

	it("keeps the daemon while a watch is open, even when idle", async () => {
		const env = new SpritesExecutionEnv({ sprite, cwd: "/tmp", idleTimeoutMs: 300 });
		try {
			const changes: unknown[] = [];
			const watcher = getOrThrow(await env.watch([{ path: "watched.txt" }], (change) => changes.push(change), context));
			const session = await env.daemon.session();
			await new Promise((resolve) => setTimeout(resolve, 1200));
			expect(await env.daemon.session()).toBe(session);
			getOrThrow(await env.writeFile("watched.txt", "x", context));
			await until(async () => changes.length > 0, 5000);
			await watcher.close(context);
		} finally {
			env.close();
		}
	});

	it("starts the daemon again after it dies", async () => {
		const env = new SpritesExecutionEnv({ sprite, cwd: "/tmp", idleTimeoutMs: 0 });
		try {
			getOrThrow(await env.writeFile("restart.txt", "kept", context));
			const before = await env.daemon.session();
			await sprite.execFile("sh", ["-c", "pkill -f '[p]i-env-.* serve' || true"]);
			await until(async () => {
				try {
					return (await env.daemon.session()) !== before;
				} catch {
					return false;
				}
			});
			expect(getOrThrow(await env.readTextFile("restart.txt", context))).toBe("kept");
		} finally {
			env.close();
		}
	});

	it("leaves no daemon running after close", async () => {
		const env = new SpritesExecutionEnv({ sprite, cwd: "/tmp" });
		getOrThrow(await env.exec(["true"], undefined, context));
		expect((await daemons()).length).toBeGreaterThan(0);
		env.close();
		await until(async () => (await daemons()).length === 0);
	});
});
