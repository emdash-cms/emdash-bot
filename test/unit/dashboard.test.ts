import { describe, expect, it } from "vite-plus/test";
import { type CaseSummary, boardGroup, renderBoard } from "../../src/reports/dashboard.ts";

const NOW = Date.UTC(2026, 9, 17, 10, 0);
const base: CaseSummary = {
	caseId: "1-issue-1",
	repo: "acme/widgets",
	kind: "issue",
	number: 12,
	title: "Greeting lacks punctuation",
	url: "https://github.com/acme/widgets/issues/12",
	pr: 40,
	previewUrl: "https://issue-12.preview.example",
	status: "candidate-published",
	group: "waiting",
	queued: false,
	reasons: ["no review of the current head yet"],
	nextAction: "the review bot will review the current head, or a maintainer can approve it",
	assignedBy: "maintainer",
	autoIntake: false,
	createdAt: NOW - 90 * 60_000,
	lastActivity: NOW - 5 * 60_000,
	checks: { passed: 7, total: 7 },
	review: null,
	reporterConfirmed: false,
	plan: [{ title: "Add the comma", status: "completed" }],
	timeline: [{ at: NOW - 80 * 60_000, text: "Assigned by @maintainer" }],
	finishedAt: null,
};
const options = {
	repos: ["acme/widgets"],
	intakeLabel: "bot:fix",
	botHandle: "emdash-autofix",
	maxActiveAuthors: 2,
	now: NOW,
};

describe("case board", () => {
	it("groups statuses by who acts next", () => {
		expect(boardGroup("needs-human")).toBe("human");
		expect(boardGroup("ready-for-human")).toBe("ready");
		expect(boardGroup("working")).toBe("working");
		expect(boardGroup("changes-required")).toBe("working");
		expect(boardGroup("waiting-for-checks")).toBe("waiting");
		expect(boardGroup("waiting-for-reply")).toBe("waiting");
		expect(boardGroup("terminal")).toBe("finished");
	});

	it("renders each case in its group with its next action and evidence", () => {
		const html = renderBoard(
			[
				base,
				{ ...base, caseId: "2", number: 13, status: "working", group: "working", queued: true },
				{ ...base, caseId: "3", number: 14, status: "working", group: "working" },
				{ ...base, caseId: "4", number: 15, status: "working", group: "working" },
			],
			options,
		);
		const waiting = html.slice(html.indexOf('id="waiting"'), html.indexOf('id="finished"'));
		expect(waiting).toContain("#12");
		expect(waiting).toContain(
			"The review bot will review the current head, or a maintainer can approve it.",
		);
		expect(waiting).toContain("no review yet");
		expect(waiting).toContain("checks 7/7");
		expect(waiting).toContain("https://issue-12.preview.example");
		expect(html).toContain("Waiting for a slot");
		expect(html).toContain("All 2 slots in use · 1 queued");
		expect(html).toContain("Nothing needs a maintainer.");
		expect(html).toContain("bot:fix");
	});

	it("says who reviewed", () => {
		const review = (by: string, state: string, maintainer: boolean, actionable = 0) =>
			renderBoard([{ ...base, review: { by, state, maintainer, actionable } }], options);
		expect(review("ascorbic", "APPROVED", true)).toContain("approved by @ascorbic");
		expect(review("ascorbic", "CHANGES_REQUESTED", true, 1)).toContain(
			"changes requested by @ascorbic",
		);
		expect(review("emdashbot[bot]", "COMMENTED", false, 2)).toContain("review bot: 2 to address");
		expect(review("emdashbot[bot]", "APPROVED", false)).toContain("approved by @emdashbot");
	});

	it("escapes text from issues", () => {
		const html = renderBoard([{ ...base, title: "<script>alert(1)</script>" }], options);
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});
});
