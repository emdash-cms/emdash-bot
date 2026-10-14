import { defineConfig } from "cf/config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "emdash-bot",
		entrypoint,
		compatibilityDate,
		compatibilityFlags,
		observability: {
			enabled: true,
		},
	},
});
