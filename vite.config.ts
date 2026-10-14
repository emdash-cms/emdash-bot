import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
	// Tests run in Node against the built Worker in Miniflare (see
	// test/harness.ts), so the Cloudflare plugin is only for dev and build.
	plugins: process.env.VITEST ? [] : [cloudflare()],
	test: {
		globalSetup: "./test/global-setup.ts",
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
