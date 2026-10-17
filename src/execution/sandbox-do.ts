// One disposable Linux sandbox per name, backed by the Durable Object's
// Container. It holds no GitHub write credential and no bot or provider
// secret. Internet access is off; the only reachable hosts are intercepted
// and filtered by `SandboxEgress`, which adds read-only repository access
// outside the container.

import { DurableObject } from "cloudflare:workers";
import type { ExecRequest, ExecResult, SandboxScope } from "./backend.ts";

const INACTIVITY_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CA_SOURCE = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
export const EGRESS_HOSTS = ["github.com", "registry.npmjs.org"] as const;

const BASE_ENV: Record<string, string> = {
	HOME: "/root",
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	CI: "1",
	PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
	GIT_TERMINAL_PROMPT: "0",
	GIT_CONFIG_NOSYSTEM: "1",
	NODE_EXTRA_CA_CERTS: CA_SOURCE,
	GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
	npm_config_cafile: "/etc/ssl/certs/ca-certificates.crt",
};

async function readAll(stream: ReadableStream | null, limit: number): Promise<Uint8Array> {
	if (!stream) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of stream as ReadableStream<Uint8Array>) {
		if (size < limit) chunks.push(chunk.subarray(0, limit - size));
		size += chunk.byteLength;
	}
	const out = new Uint8Array(Math.min(size, limit));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export class SandboxDO extends DurableObject<Env> {
	#started: Promise<void> | undefined;

	private get container(): Container {
		const container = this.ctx.container;
		if (!container) throw new Error("the container binding is not configured");
		return container;
	}

	async #start(scope: SandboxScope): Promise<void> {
		const container = this.container;
		if (!container.running) {
			container.start({
				image: container.images.workspace!,
				enableInternet: false,
				// 4 vCPU, 12 GiB: EmDash's root build and repository-wide checks run several Node processes at once.
				instance: "standard-4",
				labels: { case: scope.caseId.slice(0, 63) },
			});
		}
		await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
		const egress = this.ctx.exports.SandboxEgress({ props: scope });
		for (const host of EGRESS_HOSTS) await container.interceptOutboundHttps(host, egress);
		await container.interceptAllOutboundHttp(
			this.ctx.exports.SandboxEgress({ props: { ...scope, deny: true } }),
		);
		// Trust the interception CA so TLS clients accept intercepted hosts.
		const trust = await container.exec(
			[
				"sh",
				"-c",
				`test -f ${CA_SOURCE} && cp ${CA_SOURCE} /usr/local/share/ca-certificates/cf.crt && update-ca-certificates >/dev/null 2>&1; mkdir -p /workspace`,
			],
			{ env: BASE_ENV },
		);
		await trust.exitCode;
	}

	async exec(request: ExecRequest, scope: SandboxScope): Promise<ExecResult> {
		if (!this.container.running) this.#started = undefined;
		this.#started ??= this.#start(scope).catch((error: unknown) => {
			this.#started = undefined;
			throw error;
		});
		await this.#started;
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			const stdin = request.stdin
				? new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(request.stdin!);
							c.close();
						},
					})
				: undefined;
			const process = await this.container.exec([...request.argv], {
				cwd: request.cwd,
				env: { ...BASE_ENV, ...request.env },
				signal: controller.signal,
				...(stdin ? { stdin } : {}),
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readAll(process.stdout, MAX_OUTPUT_BYTES),
				readAll(process.stderr, MAX_OUTPUT_BYTES),
				process.exitCode,
			]);
			return { exitCode: timedOut ? 124 : exitCode, stdout, stderr, timedOut };
		} catch (error) {
			if (timedOut)
				return {
					exitCode: 124,
					stdout: new Uint8Array(),
					stderr: new TextEncoder().encode("timed out"),
					timedOut,
				};
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	async destroy(): Promise<void> {
		this.#started = undefined;
		if (this.ctx.container?.running) await this.ctx.container.destroy();
	}
}
