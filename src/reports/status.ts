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
	/** Required checks on the current head that failed transiently and the bot can no longer re-run. */
	readonly rerunsExhausted?: readonly string[];
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
	/** The review that decides readiness on the current head (or a commit it only formats): a maintainer's latest approval or change request, else the configured reviewer's latest review. */
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

/**
 * A review blocks readiness only when it requests changes. What a commented
 * review needs (a fix, a reply, nothing) is the author's judgement; it answers
 * every review, and a new head gets a new review.
 */
export function reviewIsClean(review: ReviewRecord): boolean {
	return review.state.toUpperCase() !== "CHANGES_REQUESTED";
}

function reviewedBy(review: ReviewRecord): string {
	const who = review.maintainer ? `@${review.reviewer}` : "the review bot";
	return review.state.toUpperCase() === "APPROVED"
		? `${who} approved the current head`
		: `${who} reviewed the current head`;
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
	const onHead = input.reviews.filter((r) => covered.has(r.commit));
	// A maintainer's latest approval or change request on this head outranks the review bot.
	const review =
		onHead.filter((r) => r.maintainer).at(-1) ?? onHead.filter((r) => !r.maintainer).at(-1);
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
	// The author is told when publication stops (the branch moved under it) and rebuilds.
	if (publication.state === "needs-human")
		return report(
			"changes-required",
			[`publication stopped: ${publication.error ?? publication.state}`],
			"the bot will rebuild its change on the current branch head",
		);
	if (publication.state === "failed")
		return report(
			"needs-human",
			[`publication failed: ${publication.error ?? publication.state}`],
			"an operator will look at the publication receipt",
		);
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
	const failed = checks.filter((c) => c.state === "failed");
	const describe = (c: RequiredCheck) => `${c.name}: ${c.classification} (${c.detail})`;
	// Administrative checks are human gates (a CLA, an approval); only people can pass them.
	const gates = failed.filter((c) => c.classification === "administrative");
	if (gates.length > 0)
		return report("needs-human", gates.map(describe), "a maintainer will look at the failed check");
	// Transient failures are re-run by the bot, a limited number of times.
	const transient = failed.filter(
		(c) => c.classification === "infrastructure" || c.classification === "cancellation",
	);
	const exhausted = transient.filter((c) => input.rerunsExhausted?.includes(c.name));
	if (exhausted.length > 0)
		return report(
			"needs-human",
			exhausted.map(describe),
			"a maintainer will re-run the failed check once the infrastructure problem clears",
		);
	if (transient.length > 0)
		return report(
			"waiting-for-checks",
			transient.map(describe),
			"the bot will re-run the failed check",
		);
	// Anything else unexplained goes to the author with its log.
	if (failed.length > 0)
		return report(
			"changes-required",
			failed.map(describe),
			"the bot will investigate the failing check",
		);
	if (review && !reviewIsClean(review)) {
		const who = review.maintainer ? `@${review.reviewer}` : "the review bot";
		return report(
			"changes-required",
			[`${who} requested changes on the current head`],
			`the bot will respond to ${review.maintainer ? `${who}'s` : "the"} review`,
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
			["no review of the current head yet"],
			"the review bot will review the current head, or a maintainer can approve it",
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
			"changes-required",
			["the pull request does not merge cleanly with the default branch"],
			"the bot will merge the default branch and resolve the conflict",
		);
	return report(
		"ready-for-human",
		[`required checks passed, ${reviewedBy(review)}, and the head merges cleanly`],
		"a maintainer will review and approve the pull request",
	);
}
