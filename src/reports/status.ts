// Deterministic case status from recorded evidence and the live pull request.
// Status reports what can be observed; it never decides what the author does.

import type { CheckPolicy } from "../config.ts";
import type {
	Candidate,
	CaseState,
	CaseStatus,
	Publication,
	ReviewRecord,
	Verification,
} from "../cases/types.ts";
import { str } from "../util.ts";

export interface StatusInput {
	readonly state: CaseState | undefined;
	readonly authorBusy: boolean;
	/** Whether the author has run at all in this case. */
	readonly authorStarted: boolean;
	/** Whether messages for the author are held until an author slot frees up. */
	readonly waitingForSlot?: boolean;
	readonly handoff: { reason: string; nextAction: string; at: number } | undefined;
	readonly candidates: readonly Candidate[];
	readonly publications: readonly Publication[];
	readonly verifications: readonly Verification[];
	readonly reviews: readonly ReviewRecord[];
	/** The branch head last observed on GitHub, when known. */
	readonly observedHead: string | null;
	/** Format-only commits, mapped to their parent: a review of the parent covers them. */
	readonly formatParents?: Readonly<Record<string, string>>;
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
	/** The configured reviewer's latest review of the current head (or the commit it formats), if any. */
	readonly review: ReviewRecord | undefined;
	readonly reviewedHead: boolean;
	readonly humanApproval: "required";
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

/** A review is clean when it approves, or when its findings block lists nothing actionable. */
export function reviewIsClean(review: ReviewRecord): boolean {
	return (
		review.state.toUpperCase() === "APPROVED" || (review.structured && review.actionable === 0)
	);
}

const WILL_UPDATE = "the bot will update this comment when it has something to show";

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
	const checks = requiredChecks(input.policy, input.verifications, head);
	// The head and the commits it only formats: a review or publication of one covers them all.
	const covered = new Set<string>();
	for (
		let commit: string | undefined = head ?? undefined;
		commit && !covered.has(commit);
		commit = input.formatParents?.[commit]
	)
		covered.add(commit);
	const review = input.reviews.filter((r) => covered.has(r.commit)).at(-1);
	const base = {
		candidate,
		publication,
		head,
		requiredChecks: checks,
		review,
		reviewedHead: review !== undefined,
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
	if (input.state === "declined")
		return report(
			"declined",
			[input.handoff?.reason ?? "the bot declined this issue"],
			"a maintainer can apply the intake label to assign it anyway",
		);
	if (input.authorBusy) return report("working", ["the bot is working"], WILL_UPDATE);
	if (input.waitingForSlot)
		return report(
			"working",
			["the bot is busy with other issues and will start when one finishes"],
			WILL_UPDATE,
		);
	// Includes a case created ahead of admission (an operator fixture before intake).
	if (!input.authorStarted && !input.handoff)
		return report("working", ["the bot is starting"], WILL_UPDATE);
	if (input.handoff) return report("needs-human", [input.handoff.reason], input.handoff.nextAction);
	if (!candidate)
		return report(
			"waiting-for-reply",
			["the bot has stopped without proposing a change"],
			"the bot will continue when the reporter or a maintainer replies",
		);
	if (!publication || publication.state === "intent" || publication.state === "commit-created") {
		return report(
			"working",
			["the saved candidate is being published"],
			"the bot will open or update the pull request",
		);
	}
	if (publication.state === "needs-human" || publication.state === "failed") {
		return report(
			"needs-human",
			[`publication stopped: ${publication.error ?? publication.state}`],
			"an operator will look at the publication receipt",
		);
	}
	if (publishedHead && input.observedHead && !covered.has(publishedHead)) {
		return report(
			"waiting-for-checks",
			[`the branch moved to ${input.observedHead.slice(0, 12)} after publication`],
			"the new head will need its own checks and review",
		);
	}
	const failedCode = checks.filter((c) => c.state === "failed" && c.classification === "code");
	if (failedCode.length > 0)
		return report(
			"changes-required",
			failedCode.map((c) => `${c.name} failed on the current head`),
			"the bot will fix the failing check",
		);
	const blocked = checks.filter((c) => c.state === "failed");
	if (blocked.length > 0) {
		return report(
			"needs-human",
			blocked.map((c) => `${c.name}: ${c.classification} (${c.detail})`),
			blocked.some((c) => c.classification === "infrastructure")
				? "a maintainer will re-run the failed check once the infrastructure problem clears"
				: "a maintainer will look at the failed check",
		);
	}
	if (review && !reviewIsClean(review)) {
		return report(
			"changes-required",
			[
				`the reviewer's latest review of the current head has ${review.actionable} item(s) of feedback`,
			],
			"the bot will respond to the review, and the reviewer will approve when satisfied",
		);
	}
	const pending = checks.filter((c) => c.state === "missing" || c.state === "pending");
	if (pending.length > 0)
		return report(
			"waiting-for-checks",
			pending.map((c) => `${c.name}: ${c.detail}`),
			"the bot will continue when the required checks finish",
		);
	if (!review)
		return report(
			"candidate-published",
			["no review of the current head by the configured reviewer yet"],
			"the reviewer will review the current head",
		);
	if (
		!input.mergeability ||
		input.mergeability.head !== head ||
		input.mergeability.mergeable === null
	) {
		return report(
			"candidate-published",
			["mergeability has not been assessed for the current head"],
			"the bot will check mergeability again",
		);
	}
	if (!input.mergeability.mergeable)
		return report(
			"needs-human",
			["the pull request does not merge cleanly"],
			"a maintainer will resolve the merge conflict",
		);
	return report(
		"ready-for-human",
		[
			"required checks passed, the reviewer's latest review of the current head is clean, and the head merges cleanly",
		],
		"a maintainer will review and approve the pull request",
	);
}
