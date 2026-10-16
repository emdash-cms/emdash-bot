import { describe, expect, it } from "vite-plus/test";
import { classifyCheck } from "../../src/github/checks.ts";
import { parseReview } from "../../src/github/review.ts";
import { egressDecision } from "../../src/execution/egress-policy.ts";
import { nextScriptedResponse } from "../../src/runtime/scripted-author.ts";

const policy = {
	code: ["test", "lint"],
	administrative: ["PR Maintenance"],
	required: ["test"],
	skippable: { lint: "docs-only changes" },
};
const ev = (name: string, conclusion: string | null, summary = "", headSha = "h") => ({
	name,
	conclusion,
	headSha,
	output: { summary },
});

describe("check classification", () => {
	it("classifies from exact-head evidence", () => {
		expect(classifyCheck(policy, ev("test", "failure", "AssertionError"), "h").classification).toBe(
			"code",
		);
		expect(
			classifyCheck(policy, ev("test", "failure", "AssertionError", "old"), "h").classification,
		).toBe("stale");
		expect(
			classifyCheck(policy, ev("test", "failure", "502 Bad Gateway"), "h").classification,
		).toBe("infrastructure");
		expect(classifyCheck(policy, ev("PR Maintenance", "failure", "502"), "h").classification).toBe(
			"administrative",
		);
		expect(classifyCheck(policy, ev("test", "cancelled"), "h").classification).toBe("cancellation");
		expect(classifyCheck(policy, ev("lint", "skipped"), "h").classification).toBe("success");
		expect(classifyCheck(policy, ev("test", "skipped"), "h").classification).toBe("unknown");
		expect(classifyCheck(policy, ev("deploy-preview", "failure", "boom"), "h").classification).toBe(
			"unknown",
		);
		expect(classifyCheck(policy, ev("test", "failure", ""), "h").classification).toBe("unknown");
	});
});

describe("reviewer findings adapter", () => {
	it("reads the structured block and keeps finding identities", () => {
		const body =
			'Prose.\n\n```emdash-review-findings\n{"reviewedCommit":"c1","findings":[{"id":"F1","severity":"major","path":"a.ts","line":3,"title":"t","body":"b"}],"dispositions":[{"id":"F0","status":"resolved"}]}\n```';
		const parsed = parseReview(body, 1, "c0", "COMMENTED");
		expect(parsed.structured).toBe(true);
		expect(parsed.reviewedCommit).toBe("c1");
		expect(parsed.findings[0]).toMatchObject({ id: "F1", actionable: true, line: 3 });
		expect(parsed.dispositions).toEqual([{ id: "F0", status: "resolved" }]);
	});

	it("treats an actionable review without a block as one finding", () => {
		expect(parseReview("Please fix the edge case.", 7, "c", "COMMENTED").findings).toHaveLength(1);
		expect(parseReview("LGTM", 7, "c", "APPROVED").findings).toHaveLength(0);
	});
});

describe("sandbox egress", () => {
	const props = { caseId: "c", repo: "acme/widgets" };
	const req = (method: string, url: string) => new Request(url, { method });
	it("allows registry reads and read-only fetches of the case repository only", () => {
		expect(egressDecision(req("GET", "https://registry.npmjs.org/react"), props)).toMatchObject({
			allow: true,
			authenticate: false,
		});
		expect(egressDecision(req("PUT", "https://registry.npmjs.org/react"), props).allow).toBe(false);
		expect(
			egressDecision(
				req("GET", "https://github.com/acme/widgets.git/info/refs?service=git-upload-pack"),
				props,
			),
		).toMatchObject({ allow: true, authenticate: true });
		expect(
			egressDecision(req("POST", "https://github.com/acme/widgets.git/git-upload-pack"), props)
				.allow,
		).toBe(true);
		expect(
			egressDecision(req("POST", "https://github.com/acme/widgets.git/git-receive-pack"), props)
				.allow,
		).toBe(false);
		expect(
			egressDecision(
				req("GET", "https://github.com/acme/other.git/info/refs?service=git-upload-pack"),
				props,
			).allow,
		).toBe(false);
		expect(
			egressDecision(req("GET", "https://api.github.com/repos/acme/widgets"), props).allow,
		).toBe(false);
		expect(egressDecision(req("GET", "https://evil.example/"), props).allow).toBe(false);
	});
});

describe("scripted author", () => {
	const script =
		'```scripted-author\n{"rounds":[{"steps":[{"tool":"read","args":{"path":"a"}}],"final":"done"},{"steps":[],"final":"second"}]}\n```';
	const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
	it("derives its next step from the transcript alone", () => {
		const first = nextScriptedResponse([user(script)]);
		expect(first.content.find((c) => c.type === "toolCall")).toMatchObject({
			name: "read",
			id: "call-r0-s0",
		});
		const second = nextScriptedResponse([
			user(script),
			first,
			{
				role: "toolResult",
				toolCallId: "call-r0-s0",
				toolName: "read",
				content: [],
				isError: false,
				timestamp: 0,
			} as never,
		]);
		expect(second.content).toEqual([{ type: "text", text: "done" }]);
		const nextRound = nextScriptedResponse([user(script), first, second, user("round 2")]);
		expect(nextRound.content).toEqual([{ type: "text", text: "second" }]);
	});
});

describe("reviewer severity mapping", () => {
	it("treats the reviewer's suggestions as non-actionable", () => {
		const body =
			'```emdash-review-findings\n{"findings":[{"id":"A","severity":"needs_fixing","title":"a"},{"id":"B","severity":"suggestion","title":"b"}]}\n```';
		const parsed = parseReview(body, 1, "c", "COMMENTED");
		expect(parsed.findings.map((f) => [f.id, f.actionable])).toEqual([
			["A", true],
			["B", false],
		]);
	});
});

describe("inline review comments", () => {
	it("turns each inline comment of an unstructured review into a located finding", () => {
		const parsed = parseReview("", 9, "c", "COMMENTED", [
			{ id: 4, path: "greet.js", line: 1, body: "The exclamation is a bit eager" },
		]);
		expect(parsed.findings).toEqual([
			{
				id: "review-9-c4",
				commentId: 4,
				severity: "unspecified",
				path: "greet.js",
				line: 1,
				title: "Inline comment on greet.js:1",
				body: "The exclamation is a bit eager",
				actionable: true,
			},
		]);
		expect(
			parseReview("", 9, "c", "APPROVED", [{ id: 4, path: "a", line: 1, body: "nit" }]).findings[0]
				?.actionable,
		).toBe(false);
	});
});
