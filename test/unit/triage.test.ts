import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THRESHOLDS, decide } from "../../src/runtime/triage.ts";

const answers = (kind: Record<string, number>, actionable: number, size: number) => ({
	kind: { probabilities: kind },
	actionable: { probability: actionable },
	size: { score: size },
});
const run = (a: Parameters<typeof decide>[0]) => decide(a, DEFAULT_THRESHOLDS, "clef").decision;

describe("triage decision", () => {
	it("takes on a small, actionable bug", () => {
		expect(run(answers({ bug: 0.8, small_task: 0.1 }, 0.9, 1))).toBe("take-on");
	});
	it("counts bug and small-task probability together", () => {
		expect(run(answers({ bug: 0.35, small_task: 0.35, question: 0.3 }, 0.9, 1))).toBe("take-on");
	});
	it("asks for information when a bug is not actionable", () => {
		expect(run(answers({ bug: 0.9 }, 0.2, 1))).toBe("needs-info");
	});
	it("declines an in-scope issue that is too large", () => {
		expect(run(answers({ bug: 0.9 }, 0.9, 3))).toBe("decline");
	});
	it("declines a confident feature request with a message", () => {
		expect(run(answers({ feature_request: 0.9 }, 0.9, 2))).toBe("decline");
	});
	it("declines spam silently, even when it looks like a bug too", () => {
		expect(run(answers({ spam: 0.55, bug: 0.45 }, 0.9, 0))).toBe("decline-silently");
	});
	it("declines silently when uncertain or when the answer is malformed", () => {
		expect(run(answers({ bug: 0.3, question: 0.3, feature_request: 0.4 }, 0.9, 1))).toBe(
			"decline-silently",
		);
		expect(run({})).toBe("decline-silently");
	});
});
