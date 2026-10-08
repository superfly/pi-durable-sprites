// A live demo: a real model builds and runs a web service inside a fresh Fly.io Sprite through Pi Durable, every tool
// call streamed as it happens. Halfway through, the harness process is killed with SIGKILL. A new process opens the same
// SQLite file, resumes, and the conversation continues where it stopped: the Sprite still has everything written before
// the crash. Then the result is checked through the Sprites API and the Sprite is deleted.
//
//   SPRITES_TOKEN=... ANTHROPIC_API_KEY=... node demos/demo.ts
//
// DEMO_MODEL picks the model (default claude-sonnet-5-5). demos/pi-durable-sprites.cast is a recording of this script.
// The harness runs in a child process (`node demos/demo.ts worker run|resume`), so the parent can kill it for real.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
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
	type SubmissionId,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
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
const started = Number(process.env.DEMO_T0 ?? Date.now());
const elapsed = () => dim(`${((Date.now() - started) / 1000).toFixed(1)}s`);

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

const task =
	"Build a tiny Node HTTP server in this directory that replies with this machine's hostname and uptime. " +
	'Run it as a Sprite service called web on http_port 8080, curl it to prove it works, then take a checkpoint with the comment "hello server". ' +
	"Finish with one line saying what the server returned.";

// ---------------------------------------------------------------------------------------------------------------------
// Worker: the harness process. `run` starts the conversation; `resume` reopens the same storage and continues it.
// ---------------------------------------------------------------------------------------------------------------------
async function worker(mode: "run" | "resume") {
	const name = process.env.DEMO_SPRITE!;
	const storage = process.env.DEMO_STORAGE!;
	const client = new SpritesClient(token!);
	const sprites = new SpritesEnvPool({ client });
	const models = createModels();
	models.setProvider(
		createProvider({
			id: "anthropic",
			name: "Anthropic",
			baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
			auth: { apiKey: { name: "env", resolve: async () => ({ auth: { apiKey: apiKey! }, source: "env" }) } },
			models: Object.values(ANTHROPIC_MODELS),
			api: anthropicMessagesApi(),
		}),
	);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createSpritesExtension());
	// Everything the conversation needs to continue is in this SQLite file.
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(storage, "session.sqlite")),
		// Sequential tool calls keep the stream readable; parallel is the default.
		{ models, registry, env: ({ cwd }) => sprites.env(name, { cwd }), settings: { toolExecution: "sequential" } },
		context,
	);
	const root = await harness.root(context, {
		agent: { model: { provider: "anthropic", modelId }, cwd: "/home/sprite/app" },
	});

	// Stream the conversation: each tool call as the model makes it, its output as it arrives, and the answer.
	const seen = new Set<EntryId>();
	const printedOutput = new Map<string, number>();
	/** Marks output that came from the agent's Sprite, not this machine. */
	const where = violet(`${name} │`);
	const argsSummary = (toolName: string, args: Record<string, unknown>): string => {
		switch (toolName) {
			case "bash":
				return String(args.command ?? "");
			case "write":
			case "edit":
			case "read":
				return String(args.path ?? "");
			case "sprite_service":
				return [args.action, args.name, args.cmd, ...((args.args as string[] | undefined) ?? [])]
					.filter(Boolean)
					.join(" ");
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
			const parts = (entry.model?.[0] as AssistantMessage | undefined)?.content ?? [];
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
				const line =
					text
						.trim()
						.split("\n")
						.find((candidate) => candidate.includes("[error]")) ?? "";
				out(`    ${red("✗")} ${red(line.replace("[error] ", ""))}`);
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
	if (mode === "resume") {
		// What the last process committed is already in storage; print only what happens from here.
		const results = view.value.entries.filter(ToolResultEntry.is).length;
		for (const entry of view.value.entries) seen.add(entry.id);
		const live = view.value.docs["pi.live"] as LiveState | undefined;
		for (const slot of live?.tools ?? []) printedOutput.set(slot.callId, (slot.output ?? "").length);
		out(
			`  ${green("●")} conversation reopened  ${dim(`${results} tool result${results === 1 ? "" : "s"} on disk, continuing`)}  ${elapsed()}`,
		);
	}
	view.subscribe((value) => {
		for (const entry of [...value.entries].reverse()) onEntry(entry);
		onLive(value.docs["pi.live"] as LiveState | undefined);
	});

	harness.resume();
	let submissionId: SubmissionId;
	if (mode === "run") {
		const submission = await root.submit({ type: "input", content: task }, context);
		submissionId = submission.id;
		await writeFile(join(storage, "submission"), String(submissionId));
	} else {
		submissionId = Number(await readFile(join(storage, "submission"), "utf8")) as unknown as SubmissionId;
	}
	const settled = await (await harness.submission(submissionId, context))!.wait(context);
	view.dispose();
	if (settled.status === "done" && settled.type === "input") {
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const message = entry?.model?.[0] as AssistantMessage | undefined;
		const text = (message?.content ?? [])
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("")
			.trim();
		out();
		for (const line of wrap(text)) out(`  ${bold(line)}`);
	} else {
		out(`  ${red(`unanswered: ${settled.status}`)}`);
	}
	await harness.close(context);
	sprites.close();
}

// ---------------------------------------------------------------------------------------------------------------------
// Parent: the Sprite, the two harness processes, the crash, and the checks.
// ---------------------------------------------------------------------------------------------------------------------
async function main() {
	out();
	out(`  ${bold(violet("Pi Durable"))} ${dim("×")} ${bold(violet("Fly.io Sprites"))}`);
	out(`  ${dim("Every conversation gets its own computer. And survives a crash.")}`);
	out();

	// 1. A fresh Sprite for this conversation, and a SQLite file for the conversation itself.
	const client = new SpritesClient(token!);
	const name = `pi-demo-${randomBytes(2).toString("hex")}`;
	process.stdout.write(`  ${yellow("◌")} creating Sprite ${bold(name)} …`);
	const sprite = await client.createSprite(name);
	await sprite.filesystem("/").mkdir("/home/sprite/app", { recursive: true });
	const storage = await mkdtemp(join(tmpdir(), "pi-durable-demo-"));
	out(`\r  ${green("●")} Sprite ${bold(name)} is up  ${dim(sprite.url ?? "")}  ${elapsed()}`);
	out();
	out(
		`  ${dim("harness host")}    ${bold(hostname())}  ${dim("← Pi Durable, its SQLite file and the model key stay here")}`,
	);
	out(
		`  ${dim("agent's Sprite")}  ${bold(violet(name))}  ${dim("← every file and shell tool of the conversation runs here")}`,
	);
	out();

	// 2. The task, typed like a user would.
	process.stdout.write(`  ${bold("›")} `);
	await type(task);
	out();

	// 3. First harness process. It is killed, for real, once the model is in the middle of creating the service.
	const env = { ...process.env, DEMO_SPRITE: name, DEMO_STORAGE: storage, DEMO_T0: String(started) };
	let kill = () => {};
	const run = (mode: "run" | "resume", onLine?: (line: string) => void) =>
		new Promise<number | null>((resolve) => {
			const child = spawn(process.execPath, ["--no-warnings", process.argv[1]!, "worker", mode], {
				env,
				stdio: ["ignore", "pipe", "inherit"],
			});
			child.stdout.pipe(process.stdout, { end: false });
			let buffered = "";
			child.stdout.on("data", (chunk: Buffer) => {
				buffered += chunk.toString("utf8");
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) onLine?.(line.replace(/\x1b\[[0-9;]*m/g, ""));
			});
			child.on("exit", (code, signal) => resolve(signal === "SIGKILL" ? null : code));
			kill = () => child.kill("SIGKILL");
		});
	let killedDuring: string | undefined;
	out(`  ${green("●")} harness process 1 started  ${dim(`model ${modelId}`)}`);
	const first = await run("run", (line) => {
		const call = /▸ (sprite_service)\b/.exec(line);
		if (call && killedDuring === undefined) {
			killedDuring = call[1];
			// Let the call get under way, then pull the plug.
			setTimeout(kill, 1500);
		}
	});
	if (first === null) {
		out();
		out(
			`  ${red("✗")} ${red(bold("harness process 1 killed with SIGKILL"))}  ${dim(`while ${killedDuring} was running`)}  ${elapsed()}`,
		);
		out(`    ${dim("no shutdown, no goodbye: the same as a crash, an OOM kill or a deploy")}`);
		await sleep(1800);
		out();
		// 4. Second harness process: same SQLite file, same Sprite. Nothing to restart by hand.
		out(`  ${green("●")} harness process 2 started on the same SQLite file  ${elapsed()}`);
		await run("resume");
	} else {
		out(`  ${dim("(the run finished before the kill point; nothing to resume)")}`);
	}

	// 5. Don't take the model's word for it: check through the Sprites API.
	out();
	out(`  ${dim(`checking from ${hostname()}, through the Sprites API`)}`);
	const here = existsSync("/home/sprite/app/server.js");
	const there = await sprite
		.filesystem("/home/sprite/app")
		.stat("server.js")
		.catch(() => undefined);
	out(
		`  ${!here && there ? green("✓") : red("✗")} server.js  ${dim(`${here ? "found" : "not"} on ${hostname()}`)}  ·  ${dim(there ? `${there.size} bytes in ${name}, written before the crash` : `missing in ${name}`)}`,
	);
	const service = await sprite.getService("web");
	out(
		`  ${service.state?.status === "running" ? green("✓") : red("✗")} service web ${dim(`${service.state?.status ?? "missing"} in ${name}`)}`,
	);
	const curl = String((await sprite.execFile("curl", ["-s", "http://localhost:8080"])).stdout)
		.trim()
		.replace(/\s+/g, " ");
	// A Sprite's hostname is its name.
	out(
		`  ${curl.includes(name) ? green("✓") : red("✗")} curl localhost:8080 ${dim(`in ${name}`)} → ${dim(curl.slice(0, 60))}`,
	);
	const checkpoint = (await sprite.listCheckpoints()).find((entry) => entry.comment === "hello server");
	out(
		`  ${checkpoint ? green("✓") : red("✗")} checkpoint ${dim(checkpoint ? `${checkpoint.id} "${checkpoint.comment}"` : "missing")}`,
	);

	// 6. Clean up.
	await sleep(600);
	out();
	process.stdout.write(`  ${yellow("◌")} deleting Sprite ${name} …`);
	await client.deleteSprite(name);
	await rm(storage, { recursive: true, force: true });
	out(`\r  ${green("●")} Sprite ${name} deleted  ${elapsed()}      `);
	out();
}

if (process.argv[2] === "worker") await worker(process.argv[3] === "resume" ? "resume" : "run");
else await main();
