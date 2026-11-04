import { describe, expect, it } from "vite-plus/test";
import type { CaseSummary } from "../../src/reports/dashboard.ts";
import { caseOutcome, issueOutcome, issueStats, renderStats } from "../../src/reports/stats.ts";

const NOW = Date.UTC(2026, 9, 17, 10, 0);
const DAY = 24 * 3_600_000;
const REPO = "acme/widgets";

function summary(number: number, overrides: Partial<CaseSummary> = {}): CaseSummary {
	return {
		caseId: `1-issue-${number}`,
		repo: REPO,
		kind: "issue",
		number,
		title: `Issue ${number}`,
		url: `https://github.com/${REPO}/issues/${number}`,
		pr: null,
		previewUrl: null,
		status: "working",
		group: "working",
		queued: false,
		reasons: [],
		nextAction: "",
		assignedBy: null,
		autoIntake: true,
		createdAt: NOW - DAY,
		lastActivity: NOW,
		checks: { passed: 0, total: 0 },
		review: null,
		reporterConfirmed: false,
		plan: [],
		timeline: [],
		finishedAt: null,
		...overrides,
	};
}

const merged = (number: number) =>
	summary(number, {
		status: "terminal",
		group: "finished",
		timeline: [{ at: NOW, text: "Merged" }],
	});

describe("issue stats", () => {
	it("classifies a case by how it stands", () => {
		expect(caseOutcome(merged(1))).toBe("fixed");
		expect(caseOutcome(summary(1))).toBe("progress");
		expect(caseOutcome(summary(1, { status: "ready-for-human", group: "ready" }))).toBe("progress");
		expect(caseOutcome(summary(1, { status: "needs-human", group: "human" }))).toBe("unfixed");
		expect(caseOutcome(summary(1, { status: "terminal", group: "finished" }))).toBe("unfixed");
		expect(caseOutcome(summary(1, { status: "declined", group: "finished" }))).toBe("unfixed");
	});

	it("counts an issue by its best case", () => {
		expect(issueOutcome([])).toBe("untouched");
		expect(issueOutcome([summary(1, { status: "declined", group: "finished" }), merged(1)])).toBe(
			"fixed",
		);
	});

	it("buckets opened issues into the past week, month and each week", () => {
		const issues = [
			{ repo: REPO, number: 1, createdAt: NOW - 1 * DAY },
			{ repo: REPO, number: 2, createdAt: NOW - 2 * DAY },
			{ repo: REPO, number: 3, createdAt: NOW - 3 * DAY },
			{ repo: REPO, number: 4, createdAt: NOW - 10 * DAY },
			{ repo: REPO, number: 5, createdAt: NOW - 40 * DAY },
		];
		const cases = [
			merged(1),
			summary(2),
			merged(4),
			// A pull request case never counts as an issue's outcome.
			summary(3, { kind: "pr" }),
			// Nor does a case on another repository's issue of the same number.
			{ ...merged(3), repo: "acme/other" },
		];
		const stats = issueStats([REPO], issues, cases, NOW);
		expect(stats.week.counts).toEqual({ fixed: 1, progress: 1, unfixed: 0, untouched: 1 });
		expect(stats.month.counts).toEqual({ fixed: 2, progress: 1, unfixed: 0, untouched: 1 });
		expect(stats.weeks).toHaveLength(12);
		expect(stats.weeks.at(-1)!.counts).toEqual(stats.week.counts);
		expect(stats.weeks.at(-2)!.counts).toEqual({ fixed: 1, progress: 0, unfixed: 0, untouched: 0 });
		expect(stats.weeks.at(-6)!.counts.untouched).toBe(1);
	});

	it("renders tiles, a weekly chart, a legend and a table", () => {
		const html = renderStats(
			issueStats([REPO], [{ repo: REPO, number: 1, createdAt: NOW - DAY }], [merged(1)], NOW),
		);
		expect(html).toContain("Past week");
		expect(html).toContain("Past 30 days");
		expect(html).toContain("fixed or in progress with the bot (100%)");
		expect(html).toContain('class="legend"');
		expect(html).toContain("Show as a table");
		expect(html.match(/class="col"/g)).toHaveLength(12);
	});
});
