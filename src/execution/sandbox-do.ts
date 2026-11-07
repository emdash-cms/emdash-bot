// One disposable Linux sandbox per name, backed by the Durable Object's
// Container. It holds no GitHub write credential and no bot or provider
// secret. Internet access is off; the only reachable hosts are intercepted
// and filtered by `SandboxEgress`, which adds read-only repository access
// outside the container.

import { DurableObject } from "cloudflare:workers";
import type { ExecRequest, ExecResult, SandboxScope } from "./backend.ts";

const INACTIVITY_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** How long past a command's timeout to wait for `timeout` itself before giving up on it. */
const BACKSTOP_MS = 15_000;
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

function timedOutResult(): ExecResult {
	return {
		exitCode: 124,
		stdout: new Uint8Array(),
		stderr: new TextEncoder().encode("timed out"),
		timedOut: true,
	};
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
		const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		// `timeout` signals the command's whole process group, so a server or watcher it
		// started cannot outlive the command and hold its output open.
		const argv = [
			"timeout",
			"--kill-after=5",
			`${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
			...request.argv,
		];
		const controller = new AbortController();
		let exited = false;
		let expire: () => void = () => {};
		// A backstop for processes that left the group (setsid) and still hold the output:
		// stop the command if it is still running, and stop waiting for its output.
		const expired = new Promise<"expired">((resolve) => {
			expire = () => resolve("expired");
		});
		const timer = setTimeout(() => {
			// Signalling a process that has already exited is an error.
			if (!exited) controller.abort();
			expire();
		}, timeoutMs + BACKSTOP_MS);
		try {
			const stdin = request.stdin
				? new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(request.stdin!);
							c.close();
						},
					})
				: undefined;
			const process = await this.container.exec(argv, {
				cwd: request.cwd,
				env: { ...BASE_ENV, ...request.env },
				signal: controller.signal,
				...(stdin ? { stdin } : {}),
			});
			void process.exitCode.then(
				() => (exited = true),
				() => (exited = true),
			);
			const result = await Promise.race([
				Promise.all([
					readAll(process.stdout, MAX_OUTPUT_BYTES),
					readAll(process.stderr, MAX_OUTPUT_BYTES),
					process.exitCode,
				]),
				expired,
			]);
			if (result === "expired") {
				void process.stdout?.cancel().catch(() => undefined);
				void process.stderr?.cancel().catch(() => undefined);
				return timedOutResult();
			}
			const [stdout, stderr, exitCode] = result;
			// 124 when `timeout` stopped the command, 137 when it had to kill it.
			const timedOut = exitCode === 124 || exitCode === 137;
			return { exitCode, stdout, stderr, timedOut };
		} catch (error) {
			if (controller.signal.aborted) return timedOutResult();
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
