import { describe, expect, it } from "vite-plus/test";
import { sanitize } from "../../evals/controller/provision.ts";
import { loadCase } from "../../evals/controller/attempt.ts";

describe("evaluation fixtures", () => {
	it("never links fixture text back to upstream issues", () => {
		expect(
			sanitize("See https://github.com/emdash-cms/emdash/issues/4135 and emdash-cms/emdash#12"),
		).toBe("See upstream issues 4135 and upstream #12");
	});

	it("keeps every case paired with a grader and a pinned starting point", () => {
		for (const id of ["4141", "4074", "4070", "4013", "4095", "4024", "delivery-greeting"]) {
			const { manifest, grader } = loadCase(id);
			expect(manifest.id).toBe(id);
			expect(grader.id).toBe(id);
			if (manifest.kind !== "delivery") {
				expect(manifest.source.startingCommit).toMatch(/^[0-9a-f]{40}$/);
				expect(grader.referenceCommit).toMatch(/^[0-9a-f]{40}$/);
				expect(grader.tests.length).toBeGreaterThan(0);
			}
		}
		expect(loadCase("4074").manifest.originalCandidate?.reviews[0]?.state).toBe("COMMENTED");
	});
});
