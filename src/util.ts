const encoder = new TextEncoder();

export function toBytes(value: string | Uint8Array | ArrayBuffer): Uint8Array {
	if (typeof value === "string") return encoder.encode(value);
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function text(bytes: Uint8Array | ArrayBuffer): string {
	return new TextDecoder().decode(bytes);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", toBytes(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function now(): number {
	return Date.now();
}

/** A per-object FIFO mutex. In-memory: after a restart nothing is in flight. */
export class Mutex {
	#tail: Promise<unknown> = Promise.resolve();
	run<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(fn, fn);
		this.#tail = result.catch(() => undefined);
		return result;
	}
}

export function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

/** Render an untyped record field as text without object stringification. */
export function str(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

/** Await an RPC result whose inferred stub type is not Promise-like. */
export function rpc<T = unknown>(value: unknown): Promise<T> {
	return Promise.resolve(value as T);
}
