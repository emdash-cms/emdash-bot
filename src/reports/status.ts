// Deterministic case status from recorded evidence. Statuses describe what
// can be observed; they are not model stages.

import type { CheckPolicy } from "../config.ts";
import { str } from "../util.ts";
import type {
	Candidate,
	CaseState,
	CaseStatus,
	Finding,
	Publication,
	ReviewRecord,
	Verification,
} from "../cases/types.ts";

export interface StatusInput {
	readonly state: CaseState | undefined;
	readonly authorBusy: boolean;
	readonly handoff: { reason: string; nextAction: string; at: number } | undefined;
	readonly candidates: readonly Candidate[];
	readonly publications: readonly Publication[];
	readonly verifications: readonly Verification[];
	readonly findings: readonly Finding[];
	readonly reviews: readonly ReviewRecord[];
	/** The branch head last observed on GitHub, when known. */
	readonly observedHead: string | null;
	readonly mergeability: { head: string; mergeable: boolean | null } | undefined;
	readonly policy: CheckPolicy;
}

export interface RequiredCheck {
	readonly name: string;
	readonly state: "missing" | "pending" | "succeeded" | "failed";
	readonly classification: string | null;
	readonly detail: string;
}

export interface StatusReport {
	readonly status: CaseStatus;
	readonly reasons: readonly string[];
	readonly nextAction: string;
	readonly candidate: Candidate | undefined;
	readonly publication: Publication | undefined;
	readonly head: string | null;
	readonly requiredChecks: readonly RequiredCheck[];
	readonly outstandingFindings: readonly Finding[];
	readonly reviewedHead: boolean;
	readonly humanApproval: "required";
}

const UNRESOLVED: ReadonlySet<Finding["status"]> = new Set([
	"open",
	"addressed-by-author",
	"disputed",
	"needs-human",
]);

export function outstandingFindings(findings: readonly Finding[]): Finding[] {
	return findings.filter((f) => f.actionable && UNRESOLVED.has(f.status));
}

export function requiredChecks(
	policy: CheckPolicy,
	verifications: readonly Verification[],
	head: string | null,
): RequiredCheck[] {
	return policy.required.map((name) => {
		const runs = verifications.filter(
			(v) => v.kind === "workflow" && v.name === name && head !== null && v.commitSha === head,
		);
		const latest = runs.at(-1);
		if (!latest)
			return { name, state: "missing", classification: null, detail: "no run on the current head" };
		if (latest.outcome === "queued" || latest.outcome === "running")
			return { name, state: "pending", classification: null, detail: latest.outcome };
		if (latest.classification === "success")
			return {
				name,
				state: "succeeded",
				classification: "success",
				detail: str(latest.details.reason ?? "succeeded"),
			};
		return {
			name,
			state: "failed",
			classification: latest.classification,
			detail: str(latest.details.reason ?? latest.outcome),
		};
	});
}

export function computeStatus(input: StatusInput): StatusReport {
	const candidate = input.candidates.at(-1);
	const publication = candidate
		? input.publications.filter((p) => p.candidateId === candidate.id).at(-1)
		: undefined;
	const publishedHead =
		publication?.commitSha && ["ref-updated", "pr-ensured"].includes(publication.state)
			? publication.commitSha
			: null;
	const head = input.observedHead ?? publishedHead;
	const outstanding = outstandingFindings(input.findings);
	const checks = requiredChecks(input.policy, input.verifications, head);
	const reviewedHead = head !== null && input.reviews.some((r) => r.commit === head);
	const base = {
		candidate,
		publication,
		head,
		requiredChecks: checks,
		outstandingFindings: outstanding,
		reviewedHead,
		humanApproval: "required" as const,
	};
	const report = (status: CaseStatus, reasons: string[], nextAction: string): StatusReport => ({
		...base,
		status,
		reasons,
		nextAction,
	});

	if (input.state === "cancelled") return report("cancelled", ["the case was unassigned"], "none");
	if (input.state === "terminal")
		return report("terminal", ["the pull request or issue was closed"], "none");
	if (input.authorBusy) return report("working", ["the author is working"], "wait for the author");
	if (input.handoff) return report("needs-human", [input.handoff.reason], input.handoff.nextAction);
	if (!candidate)
		return report("working", ["no candidate has been submitted"], "wait for the author");
	if (!publication || publication.state === "intent" || publication.state === "commit-created") {
		return report("working", ["the saved candidate is being published"], "wait for publication");
	}
	if (publication.state === "needs-human" || publication.state === "failed") {
		return report(
			"needs-human",
			[`publication stopped: ${publication.error ?? publication.state}`],
			"inspect the publication receipt",
		);
	}
	if (publishedHead && input.observedHead && input.observedHead !== publishedHead) {
		return report(
			"waiting-for-checks",
			[`the branch moved to ${input.observedHead.slice(0, 12)} after publication`],
			"verify and review the new head",
		);
	}

	const reasons: string[] = [];
	const open = outstanding.filter((f) => f.status === "open");
	if (open.length > 0)
		return report(
			"changes-required",
			[`${open.length} open review finding(s)`],
			"the author addresses the findings",
		);
	const failedCode = checks.filter((c) => c.state === "failed" && c.classification === "code");
	if (failedCode.length > 0)
		return report(
			"changes-required",
			failedCode.map((c) => `${c.name} failed on the current head`),
			"the author repairs the failing check",
		);
	const blocked = checks.filter((c) => c.state === "failed");
	if (blocked.length > 0) {
		return report(
			"needs-human",
			blocked.map((c) => `${c.name}: ${c.classification} (${c.detail})`),
			blocked.some((c) => c.classification === "infrastructure")
				? "re-run the failed check after the infrastructure problem clears"
				: "inspect the failed check",
		);
	}
	const disputed = outstanding.filter((f) => f.status === "disputed" || f.status === "needs-human");
	if (disputed.length > 0)
		return report(
			"needs-human",
			[`${disputed.length} disputed finding(s)`],
			"a maintainer resolves the disputed findings",
		);
	const pending = checks.filter((c) => c.state === "missing" || c.state === "pending");
	if (pending.length > 0) {
		reasons.push(...pending.map((c) => `${c.name}: ${c.detail}`));
		return report("waiting-for-checks", reasons, "wait for the required checks");
	}
	if (!reviewedHead)
		return report(
			"candidate-published",
			["no independent review of the current head yet"],
			"wait for the reviewer",
		);
	const awaiting = outstanding.filter((f) => f.status === "addressed-by-author");
	if (awaiting.length > 0)
		return report(
			"candidate-published",
			[`${awaiting.length} finding(s) await reviewer confirmation`],
			"wait for the reviewer",
		);
	if (
		!input.mergeability ||
		input.mergeability.head !== head ||
		input.mergeability.mergeable === null
	) {
		return report(
			"candidate-published",
			["mergeability has not been assessed for the current head"],
			"reassess mergeability",
		);
	}
	if (!input.mergeability.mergeable)
		return report(
			"needs-human",
			["the pull request does not merge cleanly"],
			"resolve the merge conflict",
		);
	return report(
		"ready-for-human",
		[
			"required checks passed, independent review has no unresolved findings, and the head merges cleanly",
		],
		"maintainer review and approval",
	);
}
