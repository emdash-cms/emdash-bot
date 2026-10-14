import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import staging from "./profiles/staging.json" with { type: "json" };
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The sandbox class is reached through `ctx.exports.SandboxDO`, not an env
// binding: deploy rejects a container class whose binding names a script, and
// `bindings.durableObject` always does.

// Staging profile. The production Worker (`emdash-bot`) is a separate,
// explicitly operated deployment and is not configured here.
const name = "emdash-bot-pi";

// Tests (`vp build --mode test`) never start the container, so they use a
// registry reference instead of building the image.
const sandbox = defineContainer(({ mode }) => ({
	name: `${name}-sandbox`,
	schedulingPolicy: "durable-object" as const,
	images: {
		workspace:
			mode === "test"
				? { reference: "docker.io/cloudflare/sandbox:1.0.1" }
				: { dockerfile: "./Dockerfile" },
	},
	observability: { enabled: true, logs: { enabled: true } },
}));

export default defineConfig({
	worker: {
		name,
		entrypoint,
		compatibilityDate,
		compatibilityFlags,
		observability: { enabled: true },
		exports: {
			CaseDO: exports.durableObject({ storage: "sqlite" }),
			RepositoryDO: exports.durableObject({ storage: "sqlite" }),
			SandboxDO: exports.durableObject({ storage: "sqlite", container: sandbox }),
			SandboxEgress: exports.worker(),
		},
		env: {
			CASES: bindings.durableObject({ worker: name, exportName: "CaseDO" }),
			REPOSITORIES: bindings.durableObject({ worker: name, exportName: "RepositoryDO" }),
			ARTIFACTS: bindings.r2({ name: `${name}-artifacts` }),
			AI: bindings.ai(),
			CF_VERSION_METADATA: bindings.versionMetadata(),
			BOT_CONFIG: bindings.json(staging),
			GITHUB_WEBHOOK_SECRET: bindings.secret(),
			OPERATOR_TOKEN: bindings.secret(),
			// GitHub credentials are optional secrets set by the operator: either the App
			// (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID) or, for
			// staging only, GITHUB_TOKEN. They are read through `GitHubSecrets`.
		},
	},
	containers: [sandbox],
});
