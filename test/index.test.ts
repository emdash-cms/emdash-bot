import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { startWorker } from "./harness.ts";

let mf: Miniflare;
beforeAll(() => {
	mf = startWorker();
});
afterAll(() => mf.dispose());

describe("worker", () => {
	it("reports the service and profile", async () => {
		const response = await mf.dispatchFetch("https://example.com/");
		expect(await response.json()).toEqual({ service: "emdash-bot-pi", profile: "test" });
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
