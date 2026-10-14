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
	handoff: undefined,
	candidates: [candidate],
	publications: [publication],
	verifications: [check("test", "h1", "succeeded", "success")],
	findings: [],
	reviews: [
		{
			reviewId: "r",
			reviewer: "x",
			commit: "h1",
			state: "APPROVED",
			structured: true,
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

	it("lets a new finding invalidate readiness and a green check not erase it", () => {
		const finding = { id: "F1", actionable: true, status: "open", title: "t" } as never;
		expect(computeStatus({ ...base, findings: [finding] }).status).toBe("changes-required");
		const disputed = { id: "F1", actionable: true, status: "disputed", title: "t" } as never;
		expect(computeStatus({ ...base, findings: [disputed] }).status).toBe("needs-human");
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
		expect(renderStatus(identity, computeStatus(base))).toContain("Ready for human review");
		const body = renderPullRequestBody({
			identity,
			template:
				"## What does this PR do?\n\n<!-- d -->\n\nCloses #\n\n- [ ] This PR includes AI-generated code or text — model/tool: <!-- e.g. -->\n",
			summary: "Fixes it.",
			model: "m",
			assignedBy: "maint",
		});
		expect(body).toContain("Closes #7");
		expect(body).toContain("[x] This PR includes AI-generated code or text — model/tool: m");
		expect(body).toContain("emdash-bot:case=1-issue-2");
	});
});
