// The only path out of a sandbox. Package downloads pass through read-only;
// git fetches of the case's repository gain a read-only installation token
// here, outside the container. Pushes and every other host are refused.

import { WorkerEntrypoint } from "cloudflare:workers";
import { readConfig } from "../config.ts";
import { readOnlyToken } from "../github/auth.ts";
import { type EgressProps, egressDecision } from "./egress-policy.ts";

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
