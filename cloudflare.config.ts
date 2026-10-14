import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import staging from "./profiles/staging.json" with { type: "json" };
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Staging profile. The production Worker (`emdash-bot`) is a separate,
// explicitly operated deployment and is not configured here.
const name = "emdash-bot-pi";

const sandbox = defineContainer({
	name: `${name}-sandbox`,
	schedulingPolicy: "durable-object",
	images: { workspace: { dockerfile: "./Dockerfile" } },
	observability: { enabled: true, logs: { enabled: true } },
});

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
			SANDBOX: bindings.durableObject({ worker: name, exportName: "SandboxDO" }),
			ARTIFACTS: bindings.r2({ name: `${name}-artifacts` }),
			AI: bindings.ai(),
			BOT_CONFIG: bindings.json(staging),
			GITHUB_WEBHOOK_SECRET: bindings.secret(),
			OPERATOR_TOKEN: bindings.secret(),
			GITHUB_APP_ID: bindings.secret(),
			GITHUB_APP_PRIVATE_KEY: bindings.secret(),
			GITHUB_APP_INSTALLATION_ID: bindings.secret(),
		},
	},
	containers: [sandbox],
});
