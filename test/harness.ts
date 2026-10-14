// Runs the built Worker in Miniflare, from Node. `global-setup.ts` builds it
// once per test run; each test file gets its own Miniflare instance.

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { compatibilityDate, compatibilityFlags } from "../compatibility.ts";

export const BUNDLE = ".cloudflare/output/v0/workers/default/bundle/index.js";

export function startWorker(): Miniflare {
	return new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			scriptPath: BUNDLE,
			compatibilityDate,
			compatibilityFlags,
		}),
	);
}
