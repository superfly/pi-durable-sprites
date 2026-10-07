export { type DaemonConnectionOptions, DaemonConnection, type DaemonProcess } from "./connection.ts";
export {
	connectSprite,
	DEFAULT_CWD,
	DEFAULT_IDLE_TIMEOUT_MS,
	type SpriteConnectionOptions,
	SpritesExecutionEnv,
	type SpritesExecutionEnvOptions,
} from "./env.ts";
export { SpritesEnvPool, type SpritesEnvPoolOptions } from "./pool.ts";
export { deployDaemon, openDaemon } from "./transport.ts";
export { createSpritesExtension, type SpritesExtensionOptions } from "./extension.ts";
