// Pins the author instructions and sandbox settings that eval runs showed matter.

import { describe, expect, it } from "vite-plus/test";
import { AUTHOR_METHOD } from "../../src/tools/case-tools.ts";

describe("author method", () => {
	it("asks the reporter to try the preview, or to confirm once ready when there is none", () => {
		expect(AUTHOR_METHOD).toContain('once you receive the "Preview ready" message');
		expect(AUTHOR_METHOD).toContain(
			'ask once you receive the "Ready for human review" message instead (not before)',
		);
	});

	it("keeps going until only human review remains, deciding judgement calls itself", () => {
		expect(AUTHOR_METHOD).toContain(
			"A maintainer's review and merge is the only step that needs a person.",
		);
		expect(AUTHOR_METHOD).toContain(
			"make the best defensible decision, explain it in the pull request, and carry on",
		);
		expect(AUTHOR_METHOD).toContain("End every turn with a next step");
		expect(AUTHOR_METHOD).toContain("Before you submit a candidate, call review");
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
