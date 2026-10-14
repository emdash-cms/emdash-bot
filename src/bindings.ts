// Typed access to the Durable Object namespaces. The inferred `Env` cannot
// name the exported classes without a circular reference, so the stubs are
// typed here.

import type { CaseDO } from "./cases/case-do.ts";
import type { RepositoryDO } from "./cases/repository-do.ts";
import type { SandboxDO } from "./execution/sandbox-do.ts";

interface Namespaces {
	readonly CASES: unknown;
	readonly REPOSITORIES: unknown;
	readonly SANDBOX?: unknown;
}

export function cases(env: Namespaces): DurableObjectNamespace<CaseDO> {
	return env.CASES as DurableObjectNamespace<CaseDO>;
}

export function repositories(env: Namespaces): DurableObjectNamespace<RepositoryDO> {
	return env.REPOSITORIES as DurableObjectNamespace<RepositoryDO>;
}

export function sandboxes(env: {
	readonly SANDBOX?: unknown;
}): DurableObjectNamespace<SandboxDO> | undefined {
	return env.SANDBOX as DurableObjectNamespace<SandboxDO> | undefined;
}
