// End to end: a real model drives Pi Durable's coding tools and the Sprites extension in a real Sprite.
// Needs SPRITES_TOKEN and ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL routes through a proxy such as the Sprites API gateway,
// and E2E_MODEL picks the model (default claude-sonnet-5-5). Skipped otherwise.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import {
	AssistantEntry,
	createRegistry,
	Harness,
	MemoryStorage,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Sprite } from "@fly/sprites";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSpritesExtension, type SpritesEnvPool } from "../src/index.ts";
import { pool, testSprite, token } from "./sprite.ts";

const context = BACKGROUND_CONTEXT;
const apiKey = process.env.ANTHROPIC_API_KEY;
const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const modelId = process.env.E2E_MODEL ?? "claude-sonnet-5-5";
const enabled = token !== undefined && apiKey !== undefined;

const fresh = testSprite("e2e");
let sprite: Sprite;
let sprites: SpritesEnvPool;
let harness: Harness;

const TASK = `You are working in the directory /home/sprite/e2e inside a Fly.io Sprite. Do these steps in order, using your tools:
1. Run the command \`seq 1 20000\` exactly once and note its last line.
2. Write server.js: a Node.js HTTP server on port 8080 that answers every request with the text "hello from " followed by the machine's hostname (use os.hostname()).
3. Run it as a Sprite service named "web" with http_port 8080, then confirm with a request to http://localhost:8080 from the shell.
4. Take a Sprite checkpoint with the comment "e2e".
When all steps are done, reply with one line: "DONE <last line of seq> <the text the server returned>".`;

describe.skipIf(!enabled)("end to end with a real model", () => {
	beforeAll(async () => {
		sprite = await fresh.get();
		await sprite.filesystem("/").mkdir("/home/sprite/e2e", { recursive: true });
		sprites = pool();
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "anthropic",
				name: "Anthropic",
				baseUrl,
				auth: { apiKey: { name: "env", resolve: async () => ({ auth: { apiKey: apiKey! }, source: "env" }) } },
				models: Object.values(ANTHROPIC_MODELS),
				api: anthropicMessagesApi(),
			}),
		);
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(createSpritesExtension());
		harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, env: ({ cwd }) => sprites.env(fresh.name, { cwd }) },
			context,
		);
		harness.resume();
	}, 300_000);
	afterAll(async () => {
		await harness?.close(context);
		sprites?.close();
		await fresh.destroy();
	}, 120_000);

	it(
		"writes a server, runs it as a service, checkpoints, and reports back",
		async () => {
			const root = await harness.root(context, {
				agent: { model: { provider: "anthropic", modelId }, cwd: "/home/sprite/e2e" },
			});
			const settled = await (await root.submit({ type: "input", content: TASK }, context)).wait(context);

			// Every tool call and its result head, for diagnosis.
			const page = await root.entries({}, 200, undefined, context);
			const calls = page.items.filter(ToolResultEntry.is).map((entry) => {
				const message = entry.model![0] as ToolResultMessage;
				const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				return `${message.isError ? "ERR " : ""}${message.toolName}: ${text.replace(/\s+/g, " ").slice(0, 160)}`;
			});
			console.log(calls.reverse().join("\n"));

			expect(settled.status).toBe("done");
			if (settled.status !== "done" || settled.type !== "input") throw new Error("unanswered");
			const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const message = entry?.model?.[0];
			const answer =
				message?.role === "assistant"
					? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
					: "";
			console.log("answer:", answer);
			// Step 1 exercises the output window: 20000 lines, of which the model kept only the tail.
			expect(answer).toMatch(/DONE\s+20000\s+hello from/);

			// Step 2: the file is in the Sprite.
			const server = await sprite.filesystem("/home/sprite/e2e").readFile("server.js", "utf8");
			expect(server).toContain("8080");
			// Step 3: the service runs and answers.
			expect((await sprite.getService("web")).state?.status).toBe("running");
			const curl = await sprite.execFile("curl", ["-s", "http://localhost:8080"]);
			expect(String(curl.stdout)).toBe(`hello from ${fresh.name}`);
			// Step 4: the checkpoint exists.
			const checkpoints = await sprite.listCheckpoints();
			expect(checkpoints.some((entry) => entry.comment === "e2e")).toBe(true);
		},
		600_000,
	);
});
