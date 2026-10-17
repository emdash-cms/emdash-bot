// Controller-side GitHub access with the operator's own credentials (GH_TOKEN
// or `gh auth token`). It provisions and seeds disposable fixtures only.

import { execFileSync } from "node:child_process";

let cached: string | undefined;
function token(): string {
	cached ??= process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"]).toString().trim();
	return cached;
}

export async function gh<T = any>(
	method: string,
	path: string,
	body?: unknown,
	accept: number[] = [],
): Promise<{ status: number; data: T }> {
	const response = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token()}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		// A hung request otherwise stalls the whole run silently.
		signal: AbortSignal.timeout(120_000),
	});
	const text = await response.text();
	const data = (text ? JSON.parse(text) : null) as T;
	if (!response.ok && !accept.includes(response.status))
		throw new Error(`GitHub ${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
	return { status: response.status, data };
}

/** A plain remote URL. Authenticate with gitAuthEnv(), never by putting the token in the URL. */
export function gitUrl(fullName: string): string {
	return `https://github.com/${fullName}.git`;
}

/**
 * Git environment that sends the token as an HTTP header, so it never appears
 * in a command line, a remote URL or an error message.
 */
export function gitAuthEnv(): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token()}`).toString("base64")}`,
	};
}
