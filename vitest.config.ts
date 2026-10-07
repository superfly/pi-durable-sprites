import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Every case talks to a real Sprite; the first one also creates it and deploys the daemon.
		testTimeout: 120_000,
		hookTimeout: 180_000,
	},
});
