// A live demo: a real model builds and runs a web service inside a fresh Fly.io Sprite through Pi Durable, with every
// tool call streamed as it happens, then the result is checked through the Sprites API and the Sprite is deleted.
//
//   SPRITES_TOKEN=... ANTHROPIC_API_KEY=... node demos/demo.ts
//
// DEMO_MODEL picks the model (default claude-sonnet-5-5). demos/pi-durable-sprites.cast is a recording of this script.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import {
	AssistantEntry,
	createRegistry,
	type EntryId,
	type EntryRecord,
	Harness,
	type LiveState,
	MemoryStorage,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { SpritesClient } from "@fly/sprites";
import { createSpritesExtension, SpritesEnvPool } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const token = process.env.SPRITES_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!token || !apiKey) throw new Error("Set SPRITES_TOKEN and ANTHROPIC_API_KEY");
const modelId = process.env.DEMO_MODEL ?? "claude-sonnet-5-5";

// Terminal styling.
const esc = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const bold = esc("1");
const dim = esc("2");
const violet = esc("38;5;135");
const green = esc("38;5;78");
const red = esc("38;5;203");
const yellow = esc("38;5;221");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (text = "") => process.stdout.write(`${text}\n`);
/** Word-wrap to the demo's terminal width, with a two-space indent on continuation lines. */
function wrap(text: string, width = 94): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line !== "" && line.length + 1 + word.length > width) {
			lines.push(line);
			line = word;
		} else line = line === "" ? word : `${line} ${word}`;
	}
	if (line !== "") lines.push(line);
	return lines;
}
async function type(text: string) {
	for (const [index, line] of wrap(text).entries()) {
		if (index > 0) process.stdout.write("\n    ");
		for (const char of line) {
			process.stdout.write(char);
			await sleep(/\s/.test(char) ? 40 : 18);
		}
	}
	out();
}
const started = Date.now();
const elapsed = () => dim(`${((Date.now() - started) / 1000).toFixed(1)}s`);

out();
out(`  ${bold(violet("Pi Durable"))} ${dim("×")} ${bold(violet("Fly.io Sprites"))}`);
out(`  ${dim("Every conversation gets its own computer.")}`);
out();

// 1. A fresh Sprite for this conversation.
const client = new SpritesClient(token);
const name = `pi-demo-${randomBytes(2).toString("hex")}`;
process.stdout.write(`  ${yellow("◌")} creating Sprite ${bold(name)} …`);
const sprite = await client.createSprite(name);
out(`\r  ${green("●")} Sprite ${bold(name)} is up  ${dim(sprite.url ?? "")}  ${elapsed()}`);
out();
out(`  ${dim("harness host")}    ${bold(hostname())}  ${dim("← Pi Durable, its storage and the model key stay here")}`);
out(`  ${dim("agent's Sprite")}  ${bold(violet(name))}  ${dim("← every file and shell tool of the conversation runs here")}`);

// 2. Pi Durable, with its tools running in that Sprite.
const sprites = new SpritesEnvPool({ client });
const models = createModels();
models.setProvider(
	createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
		auth: { apiKey: { name: "env", resolve: async () => ({ auth: { apiKey }, source: "env" }) } },
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
	}),
);
const registry = createRegistry();
registry.install(CodingTools);
registry.install(createSpritesExtension());
const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry, env: ({ cwd }) => sprites.env(name, { cwd }) },
	context,
);
harness.resume();
await sprite.filesystem("/").mkdir("/home/sprite/app", { recursive: true });
const root = await harness.root(context, {
	agent: { model: { provider: "anthropic", modelId }, cwd: "/home/sprite/app" },
});
out(`  ${green("●")} Pi Durable conversation open  ${dim(`model ${modelId}`)}`);
out();

// 3. The task, typed like a user would.
const task =
	"Build a tiny Node HTTP server in this directory that replies with this machine's hostname and uptime. " +
	"Run it as a Sprite service called web on http_port 8080, curl it to prove it works, then take a checkpoint with the comment \"hello server\". " +
	"Finish with one line saying what the server returned.";
process.stdout.write(`  ${bold("›")} `);
await type(task);
out();

// 4. Stream the conversation: each tool call as the model makes it, its output as it arrives, and the answer.
const seen = new Set<EntryId>();
/** Marks output that came from the agent's Sprite, not this machine. */
const where = violet(`${name} │`);
const printedOutput = new Map<string, number>();
const argsSummary = (name: string, args: Record<string, unknown>): string => {
	switch (name) {
		case "bash":
			return String(args.command ?? "");
		case "write":
		case "edit":
		case "read":
			return String(args.path ?? "");
		case "sprite_service":
			return [args.action, args.name, args.cmd, ...((args.args as string[] | undefined) ?? [])].filter(Boolean).join(" ");
		case "sprite_checkpoint":
			return String(args.comment ?? "");
		default:
			return JSON.stringify(args);
	}
};
const onEntry = (entry: EntryRecord) => {
	if (seen.has(entry.id)) return;
	seen.add(entry.id);
	if (AssistantEntry.is(entry)) {
		const message = entry.model?.[0] as AssistantMessage | undefined;
		const parts = message?.content ?? [];
		// The final answer, without tool calls, is printed in bold once the run settles.
		if (!parts.some((part) => part.type === "toolCall")) return;
		for (const part of parts) {
			if (part.type === "text" && part.text.trim()) out(`  ${dim(part.text.trim())}`);
			if (part.type === "toolCall") {
				const [first, ...rest] = argsSummary(part.name, part.arguments).split("\n");
				out(`  ${violet("▸")} ${bold(part.name)}  ${first ?? ""}  ${dim(`in ${name}`)}`);
				for (const line of rest) out(`    ${dim(line)}`);
			}
		}
	} else if (ToolResultEntry.is(entry)) {
		const message = entry.model?.[0] as ToolResultMessage | undefined;
		if (message?.isError) {
			const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			out(`    ${red("✗")} ${red(text.trim().split("\n")[0] ?? "")}`);
		} else out(`    ${green("✓")} ${elapsed()}`);
	}
};
const onLive = (live: LiveState | undefined) => {
	for (const slot of live?.tools ?? []) {
		const output = slot.output ?? "";
		const printed = printedOutput.get(slot.callId) ?? 0;
		if (output.length <= printed) continue;
		const fresh = output.slice(printed);
		printedOutput.set(slot.callId, output.length);
		const lines = fresh.split("\n").filter((line) => line.trim() !== "");
		for (const line of lines.slice(0, 6)) out(`    ${where} ${dim(line.slice(0, 80))}`);
		if (lines.length > 6) out(`    ${where} ${dim(`… ${lines.length - 6} more lines`)}`);
	}
};
const view = await root.viewState(context);
view.subscribe((value) => {
	for (const entry of [...value.entries].reverse()) onEntry(entry);
	onLive(value.docs["pi.live"] as LiveState | undefined);
});

const settled = await (await root.submit({ type: "input", content: task }, context)).wait(context);
view.dispose();
if (settled.status === "done" && settled.type === "input") {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	const text = (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("").trim();
	out();
	for (const line of wrap(text)) out(`  ${bold(line)}`);
} else {
	out(`  ${red(`unanswered: ${settled.status}`)}`);
}

// 5. Don't take the model's word for it: check through the Sprites API.
out();
out(`  ${dim(`checking from ${hostname()}, through the Sprites API`)}`);
const here = existsSync("/home/sprite/app/server.js");
const there = await sprite.filesystem("/home/sprite/app").stat("server.js").catch(() => undefined);
out(
	`  ${!here && there ? green("✓") : red("✗")} server.js  ${dim(`${here ? "found" : "not"} on ${hostname()}`)}  ·  ${dim(there ? `${there.size} bytes in ${name}` : `missing in ${name}`)}`,
);
const service = await sprite.getService("web");
out(`  ${service.state?.status === "running" ? green("✓") : red("✗")} service web ${dim(`${service.state?.status ?? "missing"} in ${name}`)}`);
const curl = String((await sprite.execFile("curl", ["-s", "http://localhost:8080"])).stdout).trim().replace(/\s+/g, " ");
// A Sprite's hostname is its name.
out(`  ${curl.includes(name) ? green("✓") : red("✗")} curl localhost:8080 ${dim(`in ${name}`)} → ${dim(curl.slice(0, 60))}`);
const checkpoint = (await sprite.listCheckpoints()).find((entry) => entry.comment === "hello server");
out(`  ${checkpoint ? green("✓") : red("✗")} checkpoint ${dim(checkpoint ? `${checkpoint.id} "${checkpoint.comment}"` : "missing")}`);

// 6. Clean up.
await harness.close(context);
sprites.close();
await sleep(600);
out();
process.stdout.write(`  ${yellow("◌")} deleting Sprite ${name} …`);
await client.deleteSprite(name);
out(`\r  ${green("●")} Sprite ${name} deleted  ${elapsed()}      `);
out();
