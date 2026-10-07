import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { JsonValue } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	createRegistry,
	Harness,
	MemoryStorage,
	SystemEntry,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSpritesExtension, type SpritesEnvPool } from "../src/index.ts";
import { pool, testSprite, token } from "./sprite.ts";

const context = BACKGROUND_CONTEXT;
const fresh = testSprite("extension");
const faux = fauxProvider();
let sprites: SpritesEnvPool;
let harness: Harness;
let conversation: Conversation;

/** Have the model call one tool, and return that call's result text. */
async function call(name: string, args: { [key: string]: JsonValue }): Promise<{ text: string; isError: boolean }> {
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done."),
	]);
	await (await conversation.submit({ type: "input", content: `Call ${name}.` }, context)).wait(context);
	const page = await conversation.entries({}, 20, undefined, context);
	const result = page.items.filter(ToolResultEntry.is).map((entry) => entry.model![0] as ToolResultMessage)[0]!;
	expect(result.toolName).toBe(name);
	const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	return { text, isError: result.isError };
}

describe.skipIf(token === undefined)("Sprites extension", () => {
	beforeAll(async () => {
		await fresh.get();
		sprites = pool();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(createSpritesExtension());
		harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, env: ({ cwd }) => sprites.env(fresh.name, { cwd }) },
			context,
		);
		conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	});
	afterAll(async () => {
		await harness?.close(context);
		sprites?.close();
		await fresh.destroy();
	});

	it("tells the model it works in a Sprite", async () => {
		await call("sprite_checkpoints", {});
		const page = await conversation.entries({}, 50, undefined, context);
		const prompt = JSON.stringify(page.items.filter(SystemEntry.is).map((entry) => entry.model));
		expect(prompt).toContain(`Fly.io Sprite \\"${fresh.name}\\"`);
		expect(prompt).toContain(".sprites.app");
	});

	it("checkpoints and restores the Sprite, then keeps working", async () => {
		await call("write", { path: "state.txt", content: "before" });
		const created = await call("sprite_checkpoint", { comment: "before change" });
		expect(created.isError).toBe(false);
		const id = /checkpoint (v\d+)/.exec(created.text)?.[1] ?? "";
		expect(id).not.toBe("");
		expect((await call("sprite_checkpoints", {})).text).toContain(`${id}\t`);
		await call("write", { path: "state.txt", content: "after" });
		expect((await call("sprite_restore", { id })).isError).toBe(false);
		// The restore stopped the daemon; the next call starts it again and sees the restored file.
		expect((await call("bash", { command: "cat state.txt" })).text).toContain("before");
	});

	it("manages services and reports the URL", async () => {
		const created = await call("sprite_service", {
			action: "create",
			name: "web",
			cmd: "python3",
			args: ["-m", "http.server", "8080"],
			http_port: 8080,
		});
		expect(created.isError).toBe(false);
		expect((await call("sprite_service", { action: "list" })).text).toMatch(/^web\t(running|starting)/m);
		expect((await call("sprite_url", {})).text).toMatch(/^https:\/\/.*\.sprites\.app\nauth: \w+$/);
		// Without allowPublicUrl the model cannot open the Sprite to everyone.
		expect((await call("sprite_url", { auth: "public" })).isError).toBe(true);
		const info = await fresh.get().then((sprite) => sprite.client.getSprite(sprite.name));
		expect(info.urlSettings?.auth).not.toBe("public");
		expect((await call("sprite_service", { action: "delete", name: "web" })).isError).toBe(false);
	});
});
