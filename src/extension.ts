import { defineExtension, defineTool, type Extension, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ServiceLogStream, Sprite, StreamMessage } from "@fly/sprites";
import { Type } from "typebox";
import { SpritesExecutionEnv } from "./env.ts";

export interface SpritesExtensionOptions {
	/** Name of the extension in the registry; default `sprites`. */
	name?: string;
	/** Let the model make the Sprite's URL public. Default false: the tool only reports the URL and its auth mode. */
	allowPublicUrl?: boolean;
}

function spriteOf(env: ExecutionEnv | undefined): Sprite {
	if (env instanceof SpritesExecutionEnv) return env.sprite;
	throw new Error("This conversation does not run in a Sprite");
}

/** Messages of a checkpoint or restore stream as text; fails on an `error` message. */
async function drain(stream: { processAll(handler: (message: StreamMessage) => void): Promise<void> }) {
	const lines: string[] = [];
	await stream.processAll((message) => {
		if (message.type === "error") throw new Error(message.error ?? message.data ?? "Sprites operation failed");
		if (message.data) lines.push(message.data);
	});
	return lines.join("\n");
}

async function drainLogs(stream: ServiceLogStream, api: ToolExecutionApi) {
	await stream.processAll((event) => {
		if (event.data) api.output(event.data.endsWith("\n") ? event.data : `${event.data}\n`);
		else if (event.type === "exit") api.output(`[exited with code ${event.exitCode}]\n`);
		else if (event.type !== "stdout" && event.type !== "stderr") api.output(`[${event.type}]\n`);
	});
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const checkpoint = defineTool({
	name: "sprite_checkpoint",
	description:
		"Save a checkpoint of the whole Sprite: its files, installed packages and services. Take one before risky changes; sprite_restore returns to it.",
	parameters: Type.Object({
		comment: Type.Optional(Type.String({ description: "What this checkpoint holds, shown in sprite_checkpoints" })),
	}),
	execute: async (args, api) => {
		const sprite = spriteOf(api.env);
		const log = await drain(await sprite.createCheckpoint(args.comment));
		const [latest] = (await sprite.listCheckpoints()).filter((entry) => entry.id !== "Current");
		return text(latest === undefined ? log : `Created checkpoint ${latest.id}.`);
	},
});

const checkpoints = defineTool({
	name: "sprite_checkpoints",
	description: "List the Sprite's checkpoints, newest first.",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async (_args, api) => {
		const list = await spriteOf(api.env).listCheckpoints();
		const lines = list.map(
			(entry) =>
				`${entry.id}\t${entry.createTime.toISOString()}${entry.comment ? `\t${entry.comment}` : ""}${entry.isAuto ? "\t(auto)" : ""}`,
		);
		return text(lines.length === 0 ? "No checkpoints." : lines.join("\n"));
	},
});

const restore = defineTool({
	name: "sprite_restore",
	description:
		"Restore the Sprite to a checkpoint. Every change to files, packages and services since that checkpoint is lost, and running processes are stopped.",
	parameters: Type.Object({ id: Type.String({ description: "Checkpoint id from sprite_checkpoints, such as v3" }) }),
	executionMode: "sequential",
	execute: async (args, api) => {
		const sprite = spriteOf(api.env);
		await drain(await sprite.restoreCheckpoint(args.id));
		return text(`Restored checkpoint ${args.id}.`);
	},
});

const service = defineTool({
	name: "sprite_service",
	description:
		"Manage long-running processes that the Sprite restarts when it wakes: servers, workers, databases. A service with http_port receives the requests to the Sprite's URL. Use this instead of backgrounding processes from bash, which stop when the Sprite sleeps.",
	parameters: Type.Object({
		action: Type.Union([
			Type.Literal("list"),
			Type.Literal("create"),
			Type.Literal("start"),
			Type.Literal("stop"),
			Type.Literal("restart"),
			Type.Literal("logs"),
			Type.Literal("delete"),
		]),
		name: Type.Optional(Type.String({ description: "Service name; required except for list" })),
		cmd: Type.Optional(Type.String({ description: "create: program to run" })),
		args: Type.Optional(Type.Array(Type.String(), { description: "create: its arguments" })),
		dir: Type.Optional(Type.String({ description: "create: working directory" })),
		env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "create: environment variables" })),
		http_port: Type.Optional(Type.Number({ description: "create: port the Sprite's URL forwards to" })),
	}),
	execute: async (args, api) => {
		const sprite = spriteOf(api.env);
		if (args.action === "list") {
			const services = await sprite.listServices();
			if (services.length === 0) return text("No services.");
			return text(
				services
					.map(
						(entry) =>
							`${entry.name}\t${entry.state?.status ?? "unknown"}\t${[entry.cmd, ...entry.args].join(" ")}${entry.httpPort ? `\thttp:${entry.httpPort}` : ""}`,
					)
					.join("\n"),
			);
		}
		const name = args.name;
		if (!name) throw new Error(`sprite_service ${args.action} needs a name`);
		switch (args.action) {
			case "create": {
				if (!args.cmd) throw new Error("sprite_service create needs cmd");
				await drainLogs(
					await sprite.createService(
						name,
						{
							cmd: args.cmd,
							...(args.args === undefined ? {} : { args: args.args }),
							...(args.dir === undefined ? {} : { dir: args.dir }),
							...(args.env === undefined ? {} : { env: args.env }),
							...(args.http_port === undefined ? {} : { httpPort: args.http_port }),
						},
						"3s",
					),
					api,
				);
				break;
			}
			case "start":
				await drainLogs(await sprite.startService(name, "3s"), api);
				break;
			case "stop":
				await drainLogs(await sprite.stopService(name), api);
				break;
			case "restart":
				await drainLogs(await sprite.restartService(name, "3s"), api);
				break;
			case "logs":
				await drainLogs(await sprite.getServiceLogs(name, { lines: 100 }), api);
				break;
			case "delete":
				await sprite.deleteService(name);
				api.output(`Deleted service ${name}.\n`);
				break;
		}
		const state = args.action === "delete" ? undefined : (await sprite.getService(name)).state;
		if (state !== undefined) api.output(`Service ${name}: ${state.status}${state.error ? ` (${state.error})` : ""}\n`);
		return {};
	},
});

function urlTool(allowPublic: boolean) {
	return defineTool({
		name: "sprite_url",
		description: allowPublic
			? "Show the Sprite's URL, which forwards to the service with http_port (or port 8080), and optionally set who may open it: public (anyone) or sprite (only the Sprite's organization)."
			: "Show the Sprite's URL, which forwards to the service with http_port (or port 8080), and who may open it.",
		parameters: allowPublic
			? Type.Object({ auth: Type.Optional(Type.Union([Type.Literal("public"), Type.Literal("sprite")])) })
			: Type.Object({}, { additionalProperties: false }),
		execute: async (args, api) => {
			const sprite = spriteOf(api.env);
			// Checked here too: the schema is the model's contract, not the host's guard.
			const auth = allowPublic ? (args as { auth?: "public" | "sprite" }).auth : undefined;
			if (auth !== undefined) await sprite.updateURLSettings({ auth });
			const info = await sprite.client.getSprite(sprite.name);
			return text(`${info.url ?? "(no URL)"}\nauth: ${info.urlSettings?.auth ?? "sprite"}`);
		},
	});
}

/**
 * Tools for the Sprite a conversation runs in (checkpoints, services, its URL) and a system prompt section that tells the
 * model about it. They act on the Sprite of the call's environment and fail in conversations whose environment is not a
 * `SpritesExecutionEnv`, where the section renders nothing.
 */
export function createSpritesExtension(options: SpritesExtensionOptions = {}): Extension {
	const urls = new Map<string, Promise<string | undefined>>();
	const urlOf = (sprite: Sprite) => {
		let url = urls.get(sprite.name);
		if (url === undefined) {
			url = sprite.client.getSprite(sprite.name).then((info) => info.url);
			url.catch(() => urls.delete(sprite.name));
			urls.set(sprite.name, url);
		}
		return url;
	};
	return defineExtension({
		name: options.name ?? "sprites",
		tools: [checkpoint, checkpoints, restore, service, urlTool(options.allowPublicUrl === true)],
		sections: [
			section("sprite", async (input) => {
				if (!(input.env instanceof SpritesExecutionEnv)) return undefined;
				const sprite = input.env.sprite;
				const url = await urlOf(sprite).catch(() => undefined);
				return [
					`Your tools run in the Fly.io Sprite "${sprite.name}": a persistent Linux machine of your own with a full shell, root through sudo, and network access. Files and installed packages stay between conversations' turns, also after the Sprite sleeps when idle.`,
					"- Processes started from bash stop when the Sprite sleeps; run servers and workers as services with sprite_service.",
					url === undefined
						? "- A service with http_port receives the requests to the Sprite's URL (sprite_url)."
						: `- ${url} forwards to the service with http_port, or to port 8080.`,
					"- Take a checkpoint with sprite_checkpoint before risky changes; sprite_restore returns to it.",
				].join("\n");
			}),
		],
	});
}
