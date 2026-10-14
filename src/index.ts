// Service entrypoint: GitHub webhook intake and the authenticated operator API.

import { readConfig } from "./config.ts";
import { verifySignature, normalize } from "./github/webhook.ts";
import { constantTimeEqual, json, rpc } from "./util.ts";
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

function authorized(request: Request, env: Env): boolean {
	const header = request.headers.get("authorization") ?? "";
	const token = env.OPERATOR_TOKEN;
	if (!token || !header.startsWith("Bearer ")) return false;
	const a = new TextEncoder().encode(header.slice(7));
	const b = new TextEncoder().encode(token);
	return constantTimeEqual(a, b);
}

async function operator(request: Request, env: Env, url: URL): Promise<Response> {
	if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
	const actor = request.headers.get("x-operator") ?? "operator";
	const parts = url.pathname.split("/").filter(Boolean).slice(1);
	if (parts[0] === "repositories" && parts[1]) {
		const stub = repositories(env).getByName(parts[1]);
		if (parts[2] === "deliveries") return json(await rpc(stub.deliveries()));
		if (parts[2] === "aliases") return json(await rpc(stub.aliases()));
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
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/webhooks/github")
			return webhook(request, env);
		if (url.pathname.startsWith("/ops/")) return operator(request, env, url);
		if (url.pathname === "/")
			return json({ service: "emdash-bot-pi", profile: readConfig(env).profile });
		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
