// Pins the author instructions and sandbox settings that eval runs showed matter.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { AUTHOR_METHOD } from "../../src/tools/case-tools.ts";

describe("author method", () => {
	it("asks the reporter to confirm only after the ready-for-review message", () => {
		expect(AUTHOR_METHOD).toContain(
			'once you receive the "Ready for human review" message (not before)',
		);
	});

	it("lets the author decide whether nits are worth fixing in this pull request", () => {
		expect(AUTHOR_METHOD).toContain(
			"For nits and optional suggestions, decide whether they are worth fixing in this pull request.",
		);
	});

	it("fixes the reported problem, not a different one", () => {
		expect(AUTHOR_METHOD).toContain("Fix the problem that was reported, not a different one.");
	});
});

describe("sandbox image", () => {
	it("gives Node a heap large enough for EmDash's core build", () => {
		const dockerfile = readFileSync("Dockerfile", "utf8");
		const heap = Number(/--max-old-space-size=(\d+)/.exec(dockerfile)?.[1]);
		// The core build ran out of heap at the default and at 6 GB; 12 GB succeeded.
		expect(heap).toBeGreaterThanOrEqual(12_288);
	});
});
