import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

export default defineConfig({
	// Tests run in Node against the built Worker in Miniflare (see
	// test/harness.ts), so the Cloudflare plugin is only for dev and build.
	plugins: process.env.VITEST ? [] : [cloudflare()],
	test: {
		globalSetup: "./test/global-setup.ts",
		// Agent worktrees under .claude hold other checkouts' copies of the suite.
		exclude: [...configDefaults.exclude, ".claude/**"],
		testTimeout: 90_000,
		hookTimeout: 30_000,
	},
	lint: {
		ignorePatterns: [".cloudflare/**", ".wrangler/**", "dist/**"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		useTabs: true,
		ignorePatterns: [".cloudflare/**", ".wrangler/**", "dist/**"],
	},
});
