// The deployed bot's operator API.

import { existsSync, readFileSync } from "node:fs";
import type { Profile } from "./types.ts";

function operatorToken(): string {
	const token =
		process.env.OPERATOR_TOKEN ??
		(existsSync(".env.staging")
			? (JSON.parse(readFileSync(".env.staging", "utf8")) as { OPERATOR_TOKEN?: string })
					.OPERATOR_TOKEN
			: undefined);
	if (!token) throw new Error("set OPERATOR_TOKEN or create .env.staging");
	return token;
}

export async function ops<T = any>(profile: Profile, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${profile.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${operatorToken()}`,
			"content-type": "application/json",
			"x-operator": "eval-controller",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`bot ${path}: ${response.status} ${text.slice(0, 300)}`);
	return JSON.parse(text) as T;
}
