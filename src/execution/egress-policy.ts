// Which sandbox requests leave the Worker, and which gain read-only repository access.

export interface EgressProps {
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
