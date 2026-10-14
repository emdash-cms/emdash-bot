import { execFileSync } from "node:child_process";

// Build the Worker once before the integration tests run against it in
// Miniflare. VITEST is unset so vite.config.ts loads the Cloudflare plugin.
export default function setup(): void {
	const { VITEST: _, ...env } = process.env;
	execFileSync("node_modules/.bin/vp", ["build", "--logLevel", "error"], { env, stdio: "inherit" });
}
