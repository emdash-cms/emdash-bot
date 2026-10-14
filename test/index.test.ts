import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { startWorker } from "./harness.ts";

let mf: Miniflare;
beforeAll(() => {
	mf = startWorker();
});
afterAll(() => mf.dispose());

describe("worker", () => {
	it("responds with a greeting", async () => {
		const response = await mf.dispatchFetch("https://example.com/");
		expect(await response.text()).toBe("Hello from worker-template");
	});

	it("serves the JSON API route", async () => {
		const response = await mf.dispatchFetch("https://example.com/api/hello");
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ hello: "world" });
	});
});
