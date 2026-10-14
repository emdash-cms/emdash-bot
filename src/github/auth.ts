// GitHub credentials stay in the Worker. Writes use an installation token;
// sandbox fetches use a separately minted token restricted to contents:read.
// A static GITHUB_TOKEN is accepted for staging setups without an App.

import type { BotConfig } from "../config.ts";

export interface GitHubSecrets {
	readonly GITHUB_APP_ID?: string;
	readonly GITHUB_APP_PRIVATE_KEY?: string;
	readonly GITHUB_APP_INSTALLATION_ID?: string;
	readonly GITHUB_TOKEN?: string;
}

interface CachedToken {
	readonly token: string;
	readonly expiresAt: number;
}

const cache = new Map<string, CachedToken>();

function b64url(bytes: Uint8Array | string): string {
	const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	let binary = "";
	for (const b of data) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemBody(pem: string): Uint8Array {
	const body = pem.replace(/-----(BEGIN|END) [^-]+-----/g, "").replace(/\s+/g, "");
	const binary = atob(body);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Wrap a PKCS#1 RSA key (GitHub's download format) as PKCS#8. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
	const len = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
	const algorithm = [
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
	];
	const octet = [0x04, ...len(pkcs1.length)];
	const inner = [0x02, 0x01, 0x00, ...algorithm, ...octet];
	const total = inner.length + pkcs1.length;
	return new Uint8Array([0x30, ...len(total), ...inner, ...pkcs1]);
}

async function appJwt(appId: string, pem: string): Promise<string> {
	const raw = pemBody(pem);
	const der = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(raw) : raw;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const now = Math.floor(Date.now() / 1000);
	const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)),
	);
	return `${input}.${b64url(signature)}`;
}

async function installationToken(
	secrets: GitHubSecrets,
	config: BotConfig,
	permissions: Record<string, string> | undefined,
	repository: string | undefined,
): Promise<string> {
	const key = `${JSON.stringify(permissions ?? {})}:${repository ?? "*"}`;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
	if (
		!secrets.GITHUB_APP_ID ||
		!secrets.GITHUB_APP_PRIVATE_KEY ||
		!secrets.GITHUB_APP_INSTALLATION_ID
	) {
		throw new Error("GitHub App credentials are not configured");
	}
	const jwt = await appJwt(secrets.GITHUB_APP_ID, secrets.GITHUB_APP_PRIVATE_KEY);
	const body: Record<string, unknown> = {};
	if (permissions) body.permissions = permissions;
	if (repository) body.repositories = [repository.split("/")[1]];
	const response = await fetch(
		`${config.githubApiUrl}/app/installations/${secrets.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${jwt}`,
				accept: "application/vnd.github+json",
				"user-agent": "emdash-bot-pi",
				"x-github-api-version": "2022-11-28",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!response.ok) throw new Error(`installation token request failed: ${response.status}`);
	const data = await response.json<{ token: string; expires_at: string }>();
	cache.set(key, { token: data.token, expiresAt: Date.parse(data.expires_at) });
	return data.token;
}

export async function writeToken(env: object, config: BotConfig): Promise<string> {
	const secrets = env as GitHubSecrets;
	if (secrets.GITHUB_TOKEN) return secrets.GITHUB_TOKEN;
	return installationToken(secrets, config, undefined, undefined);
}

export async function readOnlyToken(
	env: object,
	config: BotConfig,
	repo: string,
): Promise<string | undefined> {
	const secrets = env as GitHubSecrets;
	if (secrets.GITHUB_TOKEN) return secrets.GITHUB_TOKEN;
	if (!secrets.GITHUB_APP_ID) return undefined;
	return installationToken(secrets, config, { contents: "read", metadata: "read" }, repo);
}
