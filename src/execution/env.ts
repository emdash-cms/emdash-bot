// Pi's `ExecutionEnv` over a sandbox backend. Pi's own read, write, edit and
// bash tools run through it unchanged; the case tools wrap them with
// checkpoints. Filesystem metadata goes through a small Node helper so the
// same commands work in the Linux container and the local test backend.

import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileWatcher,
	LineScanner,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
	err,
	ok,
} from "@earendil-works/pi-durable/env";
import type { ExecBackend } from "./backend.ts";

const MAX_READ_BYTES = 16 * 1024 * 1024;

const HELPER = `
const fs = require("fs"), path = require("path");
const [op, a, b] = process.argv.slice(1);
const info = (p) => { const s = fs.lstatSync(p); return { name: path.basename(p), path: p, kind: s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : "file", size: s.size, mtimeMs: s.mtimeMs }; };
const code = (e) => ({ ENOENT: "not_found", EACCES: "permission_denied", EPERM: "permission_denied", ENOTDIR: "not_directory", EISDIR: "is_directory" }[e.code] || "unknown");
try {
  let out;
  if (op === "stat") out = info(a);
  else if (op === "list") out = fs.readdirSync(a).flatMap((n) => { try { return [info(path.join(a, n))]; } catch { return []; } });
  else if (op === "exists") out = fs.existsSync(a);
  else if (op === "realpath") out = fs.realpathSync(a);
  else if (op === "mkdir") { fs.mkdirSync(a, { recursive: b === "1" }); out = null; }
  else if (op === "remove") { fs.rmSync(a, { recursive: b?.includes("r"), force: b?.includes("f") }); out = null; }
  else if (op === "rename") { fs.renameSync(a, b); out = null; }
  else if (op === "truncate") { fs.truncateSync(a, Number(b)); out = null; }
  else if (op === "tempdir") out = fs.mkdtempSync(path.join(require("os").tmpdir(), a || "pi-"));
  process.stdout.write(JSON.stringify({ ok: true, value: out }));
} catch (e) { process.stdout.write(JSON.stringify({ ok: false, code: code(e), message: String(e.message) })); }
`;

function normalize(path: string): string {
	const absolute = path.startsWith("/");
	const parts: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") parts.pop();
		else parts.push(segment);
	}
	return `${absolute ? "/" : ""}${parts.join("/")}` || (absolute ? "/" : ".");
}

function dirname(path: string): string {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}

const decoder = new TextDecoder();

export class SandboxExecutionEnv implements ExecutionEnv {
	readonly id: string;

	constructor(
		private readonly backend: ExecBackend,
		public cwd: string,
		private readonly defaultTimeoutMs: number,
	) {
		this.id = `sandbox:${backend.id}`;
	}

	private resolve(path: string): string {
		return normalize(path.startsWith("/") ? path : `${this.cwd}/${path}`);
	}

	private async helper<T>(op: string, ...args: string[]): Promise<Result<T, FileError>> {
		const result = await this.backend.exec({
			argv: ["node", "-e", HELPER, op, ...args],
			timeoutMs: 30_000,
		});
		try {
			const parsed = JSON.parse(decoder.decode(result.stdout)) as
				| { ok: true; value: T }
				| { ok: false; code: FileErrorCode; message: string };
			return parsed.ok
				? ok(parsed.value)
				: err(new FileError(parsed.code, parsed.message, args[0]));
		} catch {
			return err(
				new FileError(
					"unknown",
					decoder.decode(result.stderr).slice(0, 500) || `helper ${op} failed`,
					args[0],
				),
			);
		}
	}

	private async readBytes(path: string): Promise<Result<Uint8Array, FileError>> {
		const info = await this.helper<FileInfo>("stat", path);
		if (!info.ok) return info;
		if (info.value.kind === "directory")
			return err(new FileError("is_directory", `${path} is a directory`, path));
		if (info.value.size > MAX_READ_BYTES)
			return err(new FileError("invalid", `${path} exceeds ${MAX_READ_BYTES} bytes`, path));
		const result = await this.backend.exec({ argv: ["cat", path], timeoutMs: 60_000 });
		if (result.exitCode !== 0)
			return err(new FileError("unknown", decoder.decode(result.stderr), path));
		return ok(result.stdout);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(normalize(parts.join("/")));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const bytes = await this.readBytes(this.resolve(path));
		return bytes.ok ? ok(decoder.decode(bytes.value)) : bytes;
	}

	async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
		return this.readBytes(this.resolve(path));
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
	): Promise<Result<string[], FileError>> {
		const content = await this.readTextFile(path);
		if (!content.ok) return content;
		const lines = content.value.split("\n");
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async openTextLineReader(path: string): Promise<Result<TextLineReader, FileError>> {
		const content = await this.readTextFile(path);
		if (!content.ok) return content;
		const lines = content.value.split("\n");
		const trailing = content.value.endsWith("\n");
		if (trailing) lines.pop();
		let index = 0;
		return ok({
			readLine: async () =>
				index < lines.length
					? ok({ text: lines[index]!, terminated: index++ < lines.length - 1 || trailing })
					: ok(undefined),
			close: async () => undefined,
		});
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
	): Promise<Result<BinaryReader, FileError>> {
		const absolute = this.resolve(path);
		const info = await this.helper<FileInfo>("stat", absolute);
		if (!info.ok) return info;
		if (info.value.kind === "directory")
			return err(new FileError("is_directory", `${path} is a directory`, absolute));
		if (info.value.kind === "symlink" && options?.noFollow)
			return err(new FileError("invalid", `${path} is a symlink`, absolute));
		const bytes = await this.readBytes(absolute);
		if (!bytes.ok) return bytes;
		const data = bytes.value;
		const fileInfo: FileInfo = { ...info.value, size: data.byteLength, kind: "file" };
		return ok({
			info: async () => ok(fileInfo),
			read: async (offset: number, length: number) => ok(data.subarray(offset, offset + length)),
			scanLines: async (range: { startLine: number; endLine?: number }) => {
				const scanner = new LineScanner(range.startLine, range.endLine);
				scanner.push(data);
				return ok(scanner.finish());
			},
			close: async () => undefined,
		});
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const result = await this.backend.exec({
			argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", absolute],
			stdin: bytes,
			timeoutMs: 60_000,
		});
		return result.exitCode === 0
			? ok(undefined)
			: err(new FileError("unknown", decoder.decode(result.stderr), absolute));
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const result = await this.backend.exec({
			argv: ["sh", "-c", 'cat >> "$1"', "sh", absolute],
			stdin: bytes,
		});
		return result.exitCode === 0
			? ok(undefined)
			: err(new FileError("unknown", decoder.decode(result.stderr), absolute));
	}

	async truncateFile(path: string, size: number): Promise<Result<void, FileError>> {
		return this.helper<void>("truncate", this.resolve(path), String(size));
	}

	async flushFile(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async renameFile(source: string, destination: string): Promise<Result<void, FileError>> {
		return this.helper<void>("rename", this.resolve(source), this.resolve(destination));
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		return this.helper<FileInfo>("stat", this.resolve(path));
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		return this.helper<FileInfo[]>("list", this.resolve(path));
	}

	async openDirReader(path: string): Promise<Result<DirReader, FileError>> {
		const entries = await this.listDir(path);
		if (!entries.ok) return entries;
		let offset = 0;
		return ok({
			next: async (max: number) => {
				const page = entries.value.slice(offset, offset + max);
				offset += page.length;
				return ok({ entries: page, done: offset >= entries.value.length });
			},
			close: async () => undefined,
		});
	}

	async watch(): Promise<Result<FileWatcher, FileError>> {
		return err(new FileError("not_supported", "the sandbox does not report file changes"));
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return this.helper<string>("realpath", this.resolve(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		return this.helper<boolean>("exists", this.resolve(path));
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
	): Promise<Result<void, FileError>> {
		return this.helper<void>("mkdir", this.resolve(path), options?.recursive ? "1" : "0");
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
	): Promise<Result<void, FileError>> {
		return this.helper<void>(
			"remove",
			this.resolve(path),
			`${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`,
		);
	}

	async createTempDir(prefix: string | undefined): Promise<Result<string, FileError>> {
		return this.helper<string>("tempdir", prefix ?? "pi-");
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir(options?.prefix);
		if (!dir.ok) return dir;
		const file = `${dir.value}/file${options?.suffix ?? ""}`;
		const written = await this.writeFile(file, "");
		return written.ok ? ok(file) : written;
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted)
			return err(new ExecutionError("aborted", "aborted before start"));
		const argv = typeof command === "string" ? ["bash", "-c", command] : [...command];
		const timeoutMs =
			options?.timeout === undefined
				? this.defaultTimeoutMs
				: Math.min(options.timeout * 1000, this.defaultTimeoutMs);
		let result;
		try {
			result = await this.backend.exec({
				argv,
				cwd: options?.cwd ?? this.cwd,
				env: options?.env,
				timeoutMs,
			});
		} catch (error) {
			return err(
				new ExecutionError("spawn_error", error instanceof Error ? error.message : String(error)),
			);
		}
		if (result.timedOut)
			return err(new ExecutionError("timeout", `timed out after ${timeoutMs} ms`));
		if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const stdout = decoder.decode(result.stdout);
		const stderr = decoder.decode(result.stderr);
		if (stdout) options?.onOutput?.(stdout, context, { stream: "stdout" });
		if (stderr) options?.onOutput?.(stderr, context, { stream: "stderr" });
		return ok({ exitCode: result.exitCode });
	}

	async cleanup(): Promise<void> {
		// The case owns the sandbox's lifetime.
	}
}

export { dirname };
