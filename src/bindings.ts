// Typed access to the Durable Object namespaces. The inferred `Env` cannot
// name the exported classes without a circular reference, so the stubs are
// typed here.

import type { CaseDO } from "./cases/case-do.ts";
import type { RepositoryDO } from "./cases/repository-do.ts";
import type { SandboxDO } from "./execution/sandbox-do.ts";

interface Namespaces {
	readonly CASES: unknown;
	readonly REPOSITORIES: unknown;
}

export function cases(env: Namespaces): DurableObjectNamespace<CaseDO> {
	return env.CASES as DurableObjectNamespace<CaseDO>;
}

export function repositories(env: Namespaces): DurableObjectNamespace<RepositoryDO> {
	return env.REPOSITORIES as DurableObjectNamespace<RepositoryDO>;
}

/** The sandbox namespace, from the loopback `ctx.exports` of the calling Worker or Durable Object. */
export function sandboxes(exports: unknown): DurableObjectNamespace<SandboxDO> | undefined {
	return (exports as { SandboxDO?: DurableObjectNamespace<SandboxDO> } | undefined)?.SandboxDO;
}
