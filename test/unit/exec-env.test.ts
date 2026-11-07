// The sandbox execution environment returns as soon as its run is aborted,
// so a command that never finishes cannot keep a stopped run alive.

import { describe, expect, it } from "vite-plus/test";
import type { ExecBackend } from "../../src/execution/backend.ts";
import { SandboxExecutionEnv } from "../../src/execution/env.ts";

const hanging: ExecBackend = {
	id: "hanging",
	exec: () => new Promise(() => {}),
	destroy: async () => {},
};

describe("sandbox execution environment", () => {
	it("returns aborted when the run is aborted while a command is still running", async () => {
		const env = new SandboxExecutionEnv(hanging, "/workspace/repo", 600_000);
		const controller = new AbortController();
		const running = env.exec("pnpm dev", undefined, { abortSignal: controller.signal } as never);
		controller.abort();
		const result = await running;
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe("aborted");
	});

	it("reports a timed-out command as a timeout", async () => {
		const timedOut: ExecBackend = {
			id: "timed-out",
			exec: async () => ({
				exitCode: 124,
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
				timedOut: true,
			}),
			destroy: async () => {},
		};
		const env = new SandboxExecutionEnv(timedOut, "/workspace/repo", 600_000);
		const result = await env.exec("sleep 9999", undefined, {} as never);
		expect(!result.ok && result.error.code).toBe("timeout");
	});
});
