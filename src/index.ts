// Service entrypoint: GitHub webhook intake and the authenticated operator API.

import { readConfig } from "./config.ts";
import { verifySignature, normalize } from "./github/webhook.ts";
import { constantTimeEqual, json, rpc, text } from "./util.ts";
import { openBackend } from "./execution/backend.ts";
import { captureSource, prepareCheckout } from "./source/workspace.ts";
import { cases, repositories } from "./bindings.ts";

export { CaseDO } from "./cases/case-do.ts";
export { RepositoryDO } from "./cases/repository-do.ts";
export { SandboxDO } from "./execution/sandbox-do.ts";
export { SandboxEgress } from "./execution/egress.ts";

async function webhook(request: Request, env: Env): Promise<Response> {
	if (!env.GITHUB_WEBHOOK_SECRET) return json({ error: "webhook secret not configured" }, 503);
	const body = await request.text();
	if (
		!(await verifySignature(
			env.GITHUB_WEBHOOK_SECRET,
			body,
			request.headers.get("x-hub-signature-256"),
		))
	) {
		return json({ error: "invalid signature" }, 401);
	}
	const deliveryId = request.headers.get("x-github-delivery");
	const eventName = request.headers.get("x-github-event");
	if (!deliveryId || !eventName) return json({ error: "missing delivery headers" }, 400);
	const config = readConfig(env);
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return json({ error: "invalid JSON" }, 400);
	}
	const repository = payload.repository as { id?: number; full_name?: string } | undefined;
	const allowed = config.repositories.find((r) => r.id === repository?.id);
	if (!allowed || allowed.fullName.toLowerCase() !== repository?.full_name?.toLowerCase()) {
		return json({ skipped: "repository is not on the allowlist" }, 202);
	}
	const normalized = normalize(config, eventName, payload as Parameters<typeof normalize>[2]);
	if ("skip" in normalized) {
		console.log(
			JSON.stringify({
				event: "webhook.skipped",
				delivery: deliveryId,
				github: eventName,
				reason: normalized.skip,
			}),
		);
		return json({ skipped: normalized.skip }, 202);
	}
	const result = await repositories(env)
		.getByName(String(allowed.id))
		.admit(deliveryId, eventName, normalized);
	return json(result, 202);
}

/** Start a sandbox, fetch a repository through the egress gate, and check that other hosts are refused. */
async function sandboxSmoke(
	env: Env,
	exports: unknown,
	repo: string,
): Promise<Record<string, unknown>> {
	const config = readConfig(env);
	const backend = openBackend(env, exports, `smoke-${Date.now()}`, { caseId: "smoke", repo });
	const timings: Record<string, number> = {};
	const step = async <T>(name: string, fn: () => Promise<T>) => {
		const started = Date.now();
		try {
			return await fn();
		} finally {
			timings[name] = Date.now() - started;
		}
	};
	try {
		const tools = await step("start", () =>
			backend.exec({
				argv: ["sh", "-c", "node --version; git --version; rg --version | head -1; pnpm --version"],
			}),
		);
		const remote = `${config.gitRemoteBase}/${repo}.git`;
		const head = await step("ls-remote", () =>
			backend.exec({ argv: ["git", "ls-remote", remote, "HEAD"], timeoutMs: 120_000 }),
		);
		const sha = text(head.stdout).split(/\s/)[0] ?? "";
		const prepared = sha
			? await step("checkout", () =>
					prepareCheckout(backend, { remoteUrl: remote, baseCommit: sha, timeoutMs: 300_000 }),
				)
			: null;
		const capture = sha ? await step("capture", () => captureSource(backend, sha)) : null;
		const denied = await step("denied", () =>
			backend.exec({
				argv: [
					"node",
					"-e",
					"fetch('https://example.com').then(r=>{console.log(r.status);process.exit(r.status===200?0:3)},e=>{console.log(String(e));process.exit(4)})",
				],
				timeoutMs: 30_000,
			}),
		);
		const registry = await step("registry", () =>
			backend.exec({
				argv: [
					"node",
					"-e",
					"fetch('https://registry.npmjs.org/left-pad').then(r=>{console.log(r.status);process.exit(r.ok?0:3)},e=>{console.log(String(e));process.exit(4)})",
				],
				timeoutMs: 30_000,
			}),
		);
		return {
			tools: text(tools.stdout).trim(),
			head: sha || text(head.stderr).slice(0, 500),
			prepared,
			emptyCapture: capture ? capture.patch.byteLength === 0 : null,
			exampleComBlocked: denied.exitCode !== 0,
			exampleCom: text(denied.stdout).trim(),
			registryReachable: registry.exitCode === 0,
			registry: text(registry.stdout).trim() || text(registry.stderr).slice(0, 300),
			timings,
		};
	} finally {
		await backend.destroy().catch(() => undefined);
	}
}

function authorized(request: Request, env: Env): boolean {
	const header = request.headers.get("authorization") ?? "";
	const token = env.OPERATOR_TOKEN;
	if (!token || !header.startsWith("Bearer ")) return false;
	const a = new TextEncoder().encode(header.slice(7));
	const b = new TextEncoder().encode(token);
	return constantTimeEqual(a, b);
}

async function operator(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	url: URL,
): Promise<Response> {
	if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
	const actor = request.headers.get("x-operator") ?? "operator";
	const parts = url.pathname.split("/").filter(Boolean).slice(1);
	if (parts[0] === "repositories" && parts[1]) {
		const stub = repositories(env).getByName(parts[1]);
		if (parts[2] === "deliveries") return json(await rpc(stub.deliveries()));
		if (parts[2] === "aliases") return json(await rpc(stub.aliases()));
	}
	if (parts[0] === "smoke" && request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as { prompt?: string; repo?: string };
		if (parts[1] === "model") {
			const stub = cases(env).getByName(`smoke-model-${Date.now()}`);
			return json(await rpc(stub.modelSmoke(body.prompt ?? "Reply with the single word: ready")));
		}
		if (parts[1] === "sandbox")
			return json(await sandboxSmoke(env, ctx.exports, body.repo ?? "emdash-cms/emdash"));
	}
	if (parts[0] === "cases" && parts[1]) {
		const stub = cases(env).getByName(decodeURIComponent(parts[1]));
		const action = parts[2] ?? "";
		if (request.method === "GET" && action === "") return json(await rpc(stub.inspect()));
		if (request.method === "GET" && action === "status") return json(await stub.status());
		if (request.method === "GET" && action === "evidence")
			return json(await rpc(stub.inspect({ transcript: true })));
		if (request.method === "POST" && action === "cancel") {
			await stub.operatorCancel(actor);
			return json({ cancelled: true });
		}
		if (request.method === "POST" && action === "resume") {
			const body = (await request.json().catch(() => ({}))) as { newRound?: string };
			await stub.operatorResume(actor, body);
			return json({ resumed: true });
		}
		if (request.method === "POST" && action === "faults") {
			const body = (await request.json()) as { boundary: string; attempt?: string };
			return json(await stub.armFault(body.boundary, body.attempt));
		}
	}
	return json({ error: "not found" }, 404);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/webhooks/github")
			return webhook(request, env);
		if (url.pathname.startsWith("/ops/")) return operator(request, env, ctx, url);
		if (url.pathname === "/")
			return json({ service: "emdash-bot-pi", profile: readConfig(env).profile });
		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
