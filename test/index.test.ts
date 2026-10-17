import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { startWorker } from "./harness.ts";

let mf: Miniflare;
beforeAll(() => {
	mf = startWorker();
});
afterAll(() => mf.dispose());

describe("worker", () => {
	it("serves the public board, and the service details only to operators", async () => {
		const board = await mf.dispatchFetch("https://example.com/");
		expect(board.headers.get("content-type")).toContain("text/html");
		expect(await board.text()).toContain("What the EmDash bot is working on");
		expect((await mf.dispatchFetch("https://example.com/ops/service")).status).toBe(401);
		expect((await mf.dispatchFetch("https://example.com/api/cases?issue=x")).status).toBe(400);
	});

	it("rejects unsigned webhooks", async () => {
		const response = await mf.dispatchFetch("https://example.com/webhooks/github", {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(503);
	});

	it("requires the operator token", async () => {
		const response = await mf.dispatchFetch("https://example.com/ops/cases/x");
		expect(response.status).toBe(401);
	});
});
