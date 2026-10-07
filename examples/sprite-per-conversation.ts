// One Sprite per conversation: the app records each conversation's Sprite in its own document, and the Harness
// environment function looks it up for every tool call. The same shape as Pi Durable's
// test/examples/29-sandbox-per-conversation.ts, with a Fly.io Sprite as the sandbox.
//
// A scripted (faux) model makes the tool calls, so no model API key is needed. Run:
//   SPRITES_TOKEN=... node examples/sprite-per-conversation.ts
// Set KEEP_SPRITES=1 to keep the two Sprites afterwards.
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, Harness, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { SpritesClient } from "@fly/sprites";
import { createSpritesExtension, SpritesEnvPool } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const token = process.env.SPRITES_TOKEN;
if (!token) throw new Error("Set SPRITES_TOKEN to a Sprites API token");
const client = new SpritesClient(token);

// Which Sprite a conversation runs in. `fork: "initial"`: a fork gets no Sprite until the app assigns one.
const SpriteDoc = defineDoc<{ name?: string }>({
	kind: "app.sprite",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

// Each conversation's model writes note.txt, then shows where it runs.
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const turn = (user: string) => [
	fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: `from ${user}\n` }), { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxToolCall("bash", { command: "hostname; pwd; cat note.txt" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("Saved."),
];
faux.setResponses([...turn("alice"), ...turn("bob")]);

// One daemon connection per Sprite, shared by every tool call of its conversation.
const sprites = new SpritesEnvPool({ client });
const registry = createRegistry();
registry.install(CodingTools);
registry.install(createSpritesExtension());
const harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		// Committed reads only; a conversation without a Sprite gets no environment, so its tools fail cleanly.
		env: async ({ conversationId, cwd, read }, envContext) => {
			const name = (await read.snapshot(SpriteDoc, conversationId, envContext))?.name;
			return name === undefined ? undefined : sprites.env(name, { cwd });
		},
	},
	context,
);

// Each user's conversation gets a fresh Sprite, recorded in the creating commit.
const model = { provider: "faux", modelId: "faux-1" };
async function conversationFor(user: string) {
	const name = `pi-durable-example-${user}-${randomBytes(3).toString("hex")}`;
	await client.createSprite(name);
	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model },
			init: async (tx, id) => {
				(await tx.doc(SpriteDoc, id)).name = name;
			},
		},
		context,
	);
	return { conversation, name };
}

const users = await Promise.all([conversationFor("alice"), conversationFor("bob")]);
try {
	for (const { conversation, name } of users) {
		await (await conversation.submit({ type: "input", content: "Leave a note." }, context)).wait(context);
		const page = await conversation.entries({}, 50, undefined, context);
		const results = page.items.filter(ToolResultEntry.is).map((entry) => entry.model![0] as ToolResultMessage);
		const bash = results.find((result) => result.toolName === "bash");
		const output = (bash?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
		console.log(`--- ${name}: bash output\n${output.trim()}`);
	}
	// Read the files back through the Sprites API, not through Pi: each note is only in its own Sprite.
	for (const { name } of users) {
		const note = await client.sprite(name).filesystem("/home/sprite").readFile("note.txt", "utf8");
		console.log(`${name}: note.txt = ${JSON.stringify(note)}`);
	}
} finally {
	await harness.close(context);
	sprites.close();
	if (process.env.KEEP_SPRITES !== "1") {
		await Promise.all(users.map(({ name }) => client.deleteSprite(name)));
	}
}
