// The narrow surface the bot needs from an execution sandbox. Production uses
// a Container-backed Durable Object (`SandboxDO`); the Miniflare test harness
// supplies a Node-side implementation over a service binding that runs real
// git in temporary directories.

import { sandboxes } from "../bindings.ts";

export interface ExecRequest {
	readonly argv: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Bytes written to the process's standard input. */
	readonly stdin?: Uint8Array;
	/** Kill the process after this many milliseconds. */
	readonly timeoutMs?: number;
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
	readonly timedOut: boolean;
}

export interface ExecBackend {
	/** Stable identity of the filesystem namespace this backend reaches. */
	readonly id: string;
	exec(request: ExecRequest): Promise<ExecResult>;
	/** Destroy the instance; the next exec starts from a clean image. */
	destroy(): Promise<void>;
}

export const WORKSPACE = "/workspace";
export const REPO_DIR = "/workspace/repo";
export const STATE_FILE = "/workspace/.emdash-bot-state";

interface FetchBackendWire {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** A backend reached over HTTP; used by the local harness. */
export class FetchExecBackend implements ExecBackend {
	constructor(
		private readonly fetcher: Fetcher,
		readonly id: string,
	) {}

	async exec(request: ExecRequest): Promise<ExecResult> {
		const response = await this.fetcher.fetch(`https://exec/${encodeURIComponent(this.id)}/exec`, {
			method: "POST",
			body: JSON.stringify({
				...request,
				stdin: request.stdin ? toBase64(request.stdin) : undefined,
			}),
		});
		if (!response.ok)
			throw new Error(`exec backend returned ${response.status}: ${await response.text()}`);
		const wire = await response.json<FetchBackendWire>();
		return {
			exitCode: wire.exitCode,
			stdout: fromBase64(wire.stdout),
			stderr: fromBase64(wire.stderr),
			timedOut: wire.timedOut,
		};
	}

	async destroy(): Promise<void> {
		await this.fetcher.fetch(`https://exec/${encodeURIComponent(this.id)}/destroy`, {
			method: "POST",
		});
	}
}

/** Backend over the `SandboxDO` namespace. */
export class SandboxExecBackend implements ExecBackend {
	constructor(
		private readonly stub: DurableObjectStub<import("./sandbox-do.ts").SandboxDO>,
		readonly id: string,
		private readonly scope: SandboxScope,
	) {}

	async exec(request: ExecRequest): Promise<ExecResult> {
		return (await this.stub.exec(request, this.scope)) as ExecResult;
	}

	async destroy(): Promise<void> {
		await this.stub.destroy();
	}
}

export interface BackendEnv {
	readonly SANDBOX?: unknown;
	readonly EXEC_FAKE?: unknown;
}

/** Select the backend for one named sandbox instance. */
/** What a sandbox may reach: one repository, read-only, and the package registry. */
export interface SandboxScope {
	readonly caseId: string;
	/** `owner/name` of the only repository the sandbox may fetch. */
	readonly repo: string;
}

export function openBackend(env: BackendEnv, name: string, scope: SandboxScope): ExecBackend {
	if (env.EXEC_FAKE) return new FetchExecBackend(env.EXEC_FAKE as Fetcher, name);
	const namespace = sandboxes(env);
	if (!namespace) throw new Error("no execution backend is configured");
	return new SandboxExecBackend(namespace.getByName(name), name, scope);
}

export async function execOk(
	backend: ExecBackend,
	request: ExecRequest,
	what: string,
): Promise<ExecResult> {
	const result = await backend.exec(request);
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).slice(-2000);
		throw new Error(
			`${what} failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${stderr}`,
		);
	}
	return result;
}
