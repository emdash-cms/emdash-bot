// Node-side sandbox backend for the Miniflare harness. Each sandbox name gets
// its own directory; `/workspace` in commands is mapped into it. Commands run
// with real git, so checkpoints and trees are real.

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

interface Wire {
	argv: string[];
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
	timeoutMs?: number;
}

export interface ExecFake {
	handler(request: Request): Promise<Response>;
	/** Destroy a sandbox, as a container replacement would. */
	destroy(name: string): void;
	readonly calls: Array<{ name: string; argv: string[] }>;
	root(name: string): string;
}

export function createExecFake(base: string): ExecFake {
	const calls: Array<{ name: string; argv: string[] }> = [];
	const root = (name: string) => join(base, "sandboxes", name.replace(/[^a-zA-Z0-9_.-]/g, "_"));
	const destroy = (name: string) => rmSync(root(name), { recursive: true, force: true });
	return {
		calls,
		root,
		destroy,
		async handler(request: Request): Promise<Response> {
			const url = new URL(request.url);
			const [, rawName, action] = url.pathname.split("/");
			const name = decodeURIComponent(rawName ?? "");
			if (action === "destroy") {
				destroy(name);
				return Response.json({ ok: true });
			}
			const wire = (await request.json()) as Wire;
			const dir = root(name);
			mkdirSync(join(dir, "workspace"), { recursive: true });
			const map = (value: string) => value.replaceAll("/workspace", join(dir, "workspace"));
			const unmap = (value: string) => value.replaceAll(join(dir, "workspace"), "/workspace");
			const argv = wire.argv.map(map);
			calls.push({ name, argv: wire.argv });
			const result = await new Promise<{
				exitCode: number;
				stdout: Buffer;
				stderr: Buffer;
				timedOut: boolean;
			}>((resolve) => {
				const child = spawn(argv[0]!, argv.slice(1), {
					cwd: wire.cwd ? map(wire.cwd) : join(dir, "workspace"),
					env: {
						PATH: process.env.PATH ?? "",
						HOME: join(dir, "home"),
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_TERMINAL_PROMPT: "0",
						...wire.env,
					},
				});
				const out: Buffer[] = [];
				const err: Buffer[] = [];
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, wire.timeoutMs ?? 60_000);
				child.stdout.on("data", (c: Buffer) => out.push(c));
				child.stderr.on("data", (c: Buffer) => err.push(c));
				child.on("error", (e) => {
					clearTimeout(timer);
					resolve({
						exitCode: 127,
						stdout: Buffer.alloc(0),
						stderr: Buffer.from(String(e)),
						timedOut: false,
					});
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					resolve({
						exitCode: timedOut ? 124 : (code ?? 1),
						stdout: Buffer.concat(out),
						stderr: Buffer.concat(err),
						timedOut,
					});
				});
				if (wire.stdin) child.stdin.end(Buffer.from(wire.stdin, "base64"));
				else child.stdin.end();
			});
			const isGitBlob = wire.argv.includes("cat-file") || wire.argv.includes("diff");
			const stdout = isGitBlob ? result.stdout : Buffer.from(unmap(result.stdout.toString("utf8")));
			return Response.json({
				exitCode: result.exitCode,
				stdout: stdout.toString("base64"),
				stderr: Buffer.from(unmap(result.stderr.toString("utf8"))).toString("base64"),
				timedOut: result.timedOut,
			});
		},
	};
}
