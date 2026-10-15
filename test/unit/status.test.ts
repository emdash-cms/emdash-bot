import { describe, expect, it } from "vite-plus/test";
import { computeStatus, type StatusInput } from "../../src/reports/status.ts";
import { renderPullRequestBody, renderStatus } from "../../src/reports/render.ts";

const candidate = { id: "c1", sourceTreeHash: "t1" } as never;
const publication = { candidateId: "c1", state: "pr-ensured", commitSha: "h1" } as never;
const check = (name: string, sha: string, outcome: string, classification: string) =>
	({
		id: `${name}${sha}`,
		kind: "workflow",
		name,
		commitSha: sha,
		outcome,
		classification,
		details: {},
	}) as never;
const base: StatusInput = {
	state: "active",
	authorBusy: false,
	authorStarted: true,
	handoff: undefined,
	candidates: [candidate],
	publications: [publication],
	verifications: [check("test", "h1", "succeeded", "success")],
	reviews: [
		{
			reviewId: "r",
			reviewer: "x",
			commit: "h1",
			state: "APPROVED",
			structured: true,
			actionable: 0,
			receivedAt: 0,
		},
	],
	observedHead: "h1",
	mergeability: { head: "h1", mergeable: true },
	policy: { code: ["test"], administrative: [], required: ["test"] },
};

describe("deterministic status", () => {
	it("is ready only with current-head checks, review and mergeability", () => {
		expect(computeStatus(base).status).toBe("ready-for-human");
		expect(computeStatus({ ...base, reviews: [] }).status).toBe("candidate-published");
		expect(
			computeStatus({ ...base, verifications: [check("test", "h0", "succeeded", "success")] })
				.status,
		).toBe("waiting-for-checks");
		expect(computeStatus({ ...base, mergeability: { head: "h0", mergeable: true } }).status).toBe(
			"candidate-published",
		);
		expect(computeStatus({ ...base, mergeability: { head: "h1", mergeable: false } }).status).toBe(
			"needs-human",
		);
	});

	it("treats the reviewer's latest review of the head as the readiness signal", () => {
		const commented = {
			reviewId: "r2",
			reviewer: "x",
			commit: "h1",
			state: "COMMENTED",
			structured: false,
			actionable: 1,
			receivedAt: 1,
		};
		expect(computeStatus({ ...base, reviews: [commented] }).status).toBe("changes-required");
		const clean = { ...commented, structured: true, actionable: 0 };
		expect(computeStatus({ ...base, reviews: [clean] }).status).toBe("ready-for-human");
		const older = { ...commented, commit: "h0" };
		expect(computeStatus({ ...base, reviews: [older] }).status).toBe("candidate-published");
	});

	it("separates code failures from infrastructure failures", () => {
		expect(
			computeStatus({ ...base, verifications: [check("test", "h1", "failed", "code")] }).status,
		).toBe("changes-required");
		const infra = computeStatus({
			...base,
			verifications: [check("test", "h1", "failed", "infrastructure")],
		});
		expect(infra.status).toBe("needs-human");
		expect(infra.nextAction).toContain("re-run");
	});

	it("renders status without instructions and fills the PR template", () => {
		const identity = { caseId: "1-issue-2", issueNumber: 7, kind: "issue" } as never;
		const rendered = renderStatus(identity, computeStatus(base));
		expect(rendered).toContain("Ready for human review");
		// The evidence table is collapsed; the status and next action stay visible.
		expect(rendered.indexOf("<details>")).toBeLessThan(rendered.indexOf("| Candidate |"));
		expect(rendered.indexOf("Next action")).toBeLessThan(rendered.indexOf("<details>"));
		const body = renderPullRequestBody({
			identity,
			template:
				"## What does this PR do?\n\n<!-- d -->\n\nCloses #\n\n- [ ] This PR includes AI-generated code or text — model/tool: <!-- e.g. -->\n",
			summary: "Fixes it.",
			model: "m",
			assignedBy: "maint",
		});
		expect(body).toContain("Closes #7\n\n- [x]");
		expect(body).toContain("[x] This PR includes AI-generated code or text — model/tool: m");
		expect(body).toContain("emdash-bot:case=1-issue-2");
	});
	it("waits for a reply, without change evidence, when the author is idle with no candidate", () => {
		const identity = { caseId: "1-issue-2", issueNumber: 7, kind: "issue" } as never;
		const report = computeStatus({ ...base, candidates: [], publications: [], observedHead: null });
		expect(report.status).toBe("waiting-for-reply");
		const body = renderStatus(identity, report);
		expect(body).toContain("Waiting for a reply");
		expect(body).not.toContain("| Candidate |");
		expect(body).not.toContain("Required checks");
	});

	it("is starting, not waiting for a reply, before the author has run", () => {
		const report = computeStatus({
			...base,
			authorStarted: false,
			candidates: [],
			publications: [],
		});
		expect(report.status).toBe("working");
		// A case created ahead of admission, as an operator fixture is.
		const unadmitted = computeStatus({ ...base, state: undefined, authorStarted: false });
		expect(unadmitted.status).toBe("working");
	});

	it("keeps the plan checklist and the status reasons as separate lists", () => {
		const identity = { caseId: "1-issue-2", issueNumber: 7, kind: "issue" } as never;
		const plan = {
			summary: "Fix it.",
			steps: [{ id: "fix", title: "Fix", status: "completed" as const }],
			updatedAt: 0,
		};
		const lines = renderStatus(identity, computeStatus(base), { plan }).split("\n");
		const lastStep = lines.findIndex((l) => l.includes("Fix") && l.startsWith("- ["));
		const firstReason = lines.findIndex((l, i) => i > lastStep && l.startsWith("- "));
		// A non-list line between them stops GitHub merging them into one loose list.
		expect(lines.slice(lastStep + 1, firstReason).some((l) => l.trim() && !l.startsWith("-"))).toBe(
			true,
		);
	});
});

describe("pull request body for automatically admitted issues", () => {
	it("does not claim a maintainer assigned or approved the change", () => {
		const identity = { caseId: "1-issue-2", issueNumber: 7, kind: "issue" } as never;
		const template =
			"## What does this PR do?\n\nCloses #\n\n- [ ] A Maintainer approved this specific change before I opened the PR\n";
		const body = renderPullRequestBody({
			identity,
			template,
			summary: "Fix.",
			model: "m",
			assignedBy: null,
		});
		expect(body).toContain("took this issue on automatically");
		expect(body).toContain("- [ ] A Maintainer approved");
		expect(body).not.toContain("assigned this issue to the EmDash bot");
	});
});
