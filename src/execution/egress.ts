// The only path out of a sandbox. Package downloads pass through read-only;
// git fetches of the case's repository gain a read-only installation token
// here, outside the container. Pushes and every other host are refused.

import { WorkerEntrypoint } from "cloudflare:workers";
import { readConfig } from "../config.ts";
import { readOnlyToken } from "../github/auth.ts";

interface EgressProps {
	readonly caseId: string;
	readonly repo: string;
	readonly deny?: boolean;
}

export function egressDecision(
	request: Request,
	props: EgressProps,
): { allow: false; reason: string } | { allow: true; authenticate: boolean } {
	if (props.deny) return { allow: false, reason: "host is not on the sandbox allowlist" };
	const url = new URL(request.url);
	if (url.hostname === "registry.npmjs.org") {
		return request.method === "GET" || request.method === "HEAD"
			? { allow: true, authenticate: false }
			: { allow: false, reason: "registry writes are not allowed" };
	}
	if (url.hostname === "github.com") {
		const base = `/${props.repo}.git`;
		const advert =
			url.pathname === `${base}/info/refs` && url.searchParams.get("service") === "git-upload-pack";
		const fetch = url.pathname === `${base}/git-upload-pack` && request.method === "POST";
		if (advert || fetch) return { allow: true, authenticate: true };
		return { allow: false, reason: "only read-only fetches of the case repository are allowed" };
	}
	return { allow: false, reason: `host ${url.hostname} is not allowed` };
}

export class SandboxEgress extends WorkerEntrypoint<Env, EgressProps> {
	override async fetch(request: Request): Promise<Response> {
		const decision = egressDecision(request, this.ctx.props);
		if (!decision.allow) {
			console.warn(
				JSON.stringify({
					event: "egress.denied",
					url: request.url,
					reason: decision.reason,
					case: this.ctx.props.caseId,
				}),
			);
			return new Response(decision.reason, { status: 403 });
		}
		const forwarded = new Request(request);
		forwarded.headers.delete("authorization");
		if (decision.authenticate) {
			const token = await readOnlyToken(this.env, readConfig(this.env), this.ctx.props.repo);
			if (token) forwarded.headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
		}
		return fetch(forwarded);
	}
}
