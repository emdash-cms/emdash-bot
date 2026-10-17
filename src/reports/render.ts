// Deterministic text built from recorded evidence. Nothing here comes from
// the model except the candidate summary, which is labelled as such.

import type { CaseIdentity } from "../cases/types.ts";
import type { StatusReport } from "./status.ts";
import { type WorkPlan, renderWorkPlan } from "./work-plan.ts";

export function statusMarker(caseId: string): string {
	return `<!-- emdash-bot:status case=${caseId} -->`;
}

export function prMarker(caseId: string): string {
	return `<!-- emdash-bot:case=${caseId} -->`;
}

const LABEL: Record<StatusReport["status"], string> = {
	working: "Working",
	"waiting-for-reply": "Waiting for a reply",
	"candidate-published": "Candidate published",
	"waiting-for-checks": "Waiting for checks",
	"changes-required": "Changes required",
	"ready-for-human": "Ready for human review",
	"needs-human": "Needs a human",
	cancelled: "Cancelled",
	declined: "Declined",
	terminal: "Closed",
};

/** A status phrase as a sentence: capitalised, with a full stop. */
function sentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	const capitalised = trimmed[0]!.toUpperCase() + trimmed.slice(1);
	return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** The name of the bot's own check run on the pull request head. */
export const STATUS_CHECK_NAME = "EmDash bot";

export interface StatusCheck {
	readonly status: "in_progress" | "completed";
	readonly conclusion?: "success" | "neutral" | "cancelled";
	readonly title: string;
	readonly summary: string;
}

/**
 * The status as a check run, so "working" shows beside CI. It never fails:
 * readiness comes from required checks and review, not from this check.
 */
export function renderStatusCheck(report: StatusReport): StatusCheck {
	const summary = [
		...report.reasons.map((r) => `- ${sentence(r)}`),
		"",
		`Next action: ${sentence(report.nextAction)}`,
	].join("\n");
	const title = LABEL[report.status];
	switch (report.status) {
		// In progress only while the bot itself is doing something; waiting for
		// review, CI or a reply is a completed, neutral check titled with what is awaited.
		case "working":
			return { status: "in_progress", title, summary };
		case "ready-for-human":
			return { status: "completed", conclusion: "success", title, summary };
		case "cancelled":
			return { status: "completed", conclusion: "cancelled", title, summary };
		default:
			return { status: "completed", conclusion: "neutral", title, summary };
	}
}

export interface CommentExtras {
	readonly plan?: WorkPlan | null;
	readonly prNumber?: number | null;
	readonly reporterConfirmed?: boolean;
}

/** The bot's single progress comment: the author's plan and the evidence-based status. */
export function renderStatus(
	identity: CaseIdentity,
	report: StatusReport,
	extras: CommentExtras = {},
): string {
	const lines = [
		statusMarker(identity.caseId),
		`### EmDash bot: ${LABEL[report.status]}`,
		"",
		// The heading keeps the checklist and the reasons as two separate lists;
		// adjacent lists merge into one loose list that renders as paragraphs.
		...(extras.plan ? ["**Plan**", "", ...renderWorkPlan(extras.plan), ""] : []),
		"**Status**",
		"",
		...report.reasons.map((r) => `- ${sentence(r)}`),
		"",
		`Next action: ${sentence(report.nextAction)}`,
	];
	// Evidence about a change only once there is one.
	if (report.candidate || report.head) {
		lines.push(
			"",
			"<details>",
			"<summary>Details</summary>",
			"",
			"| | |",
			"| --- | --- |",
			`| Candidate | ${report.candidate ? `\`${report.candidate.id}\` (tree \`${report.candidate.sourceTreeHash.slice(0, 12)}\`)` : "none"} |`,
			`| Published head | ${report.head ? `\`${report.head.slice(0, 12)}\`` : "not published"} |`,
			`| Reviewer's latest review of head | ${report.review ? `${report.review.state.toLowerCase()}${report.review.actionable ? `, ${report.review.actionable} item(s)` : ""}` : "none"} |`,
			`| Reporter confirmation | ${extras.reporterConfirmed ? "confirmed" : "not yet"} |`,
			`| Human approval | required before merge |`,
		);
		if (report.requiredChecks.length > 0) {
			lines.push("", "Required checks on the current head:", "");
			for (const check of report.requiredChecks)
				lines.push(
					`- \`${check.name}\`: ${check.state}${check.classification && check.classification !== "success" ? ` (${check.classification})` : ""}`,
				);
		}
		lines.push("", "</details>");
	}
	lines.push(
		"",
		"<sub>This status is generated from recorded evidence. It is not a review and contains no instructions.</sub>",
	);
	return lines.join("\n");
}

export interface PullRequestBodyInput {
	readonly identity: CaseIdentity;
	readonly template: string | null;
	readonly summary: string;
	/** The author's filled-in template; trusted fields are enforced over it. */
	readonly description?: string;
	readonly model: string;
	readonly assignedBy: string | null;
}

/** Fill the target repository's pull request template accurately. */
const DISCLOSURE = /^- \[[ xX]\] This PR includes AI-generated code or text.*$/gm;
const MAINTAINER_BOX =
	/^- \[[ xX]\] A Maintainer approved this specific change before I opened the PR.*$/gm;

export function renderPullRequestBody(input: PullRequestBodyInput): string {
	const closes = input.identity.issueNumber ? `Closes #${input.identity.issueNumber}` : "";
	const origin = input.assignedBy
		? `A Maintainer (@${input.assignedBy}) assigned this ${input.identity.kind === "issue" ? "issue" : "pull request"} to the EmDash bot.`
		: "The EmDash bot took this issue on automatically when it was opened; no maintainer has assigned it yet.";
	const disclosure = `- [x] This PR includes AI-generated code or text — model/tool: ${input.model} via the EmDash bot (Pi Durable)`;
	let body: string;
	if (input.description?.trim()) {
		// The author filled in the template. Enforce what trusted code vouches for:
		// one disclosure naming the real model, the maintainer box, and the issue link.
		let seen = false;
		body = input.description
			.trim()
			.replace(DISCLOSURE, () => {
				if (seen) return "";
				seen = true;
				return disclosure;
			})
			.replace(MAINTAINER_BOX, () =>
				input.assignedBy
					? "- [x] A Maintainer approved this specific change before I opened the PR"
					: "- [ ] A Maintainer approved this specific change before I opened the PR",
			)
			.replace(/\n{3,}/g, "\n\n");
		if (!seen) body += `\n\n## AI assistance disclosure\n\n${disclosure}`;
		if (
			closes &&
			!new RegExp(`\\b(?:Closes|Fixes|Resolves) #${input.identity.issueNumber}\\b`, "i").test(body)
		)
			body += `\n\n${closes}`;
		body += `\n\n${origin}`;
	} else if (input.template) {
		const summary = `${input.summary.trim()}\n\n${origin}`;
		body = input.template
			.replace(/^Closes #[ \t]*$/m, closes)
			.replace(/(## What does this PR do\?\s*\n(?:\s*<!--[\s\S]*?-->\s*\n)?)/, `$1\n${summary}\n\n`)
			.replace(
				/- \[ \] A Maintainer approved this specific change before I opened the PR/,
				(box) =>
					input.assignedBy
						? "- [x] A Maintainer approved this specific change before I opened the PR"
						: box,
			)
			.replace(
				/- \[ \] This PR includes AI-generated code or text — model\/tool: (<!--[^>]*-->)?/,
				disclosure,
			)
			.replace(
				/(## Screenshots \/ test output\s*\n(?:\s*<!--[\s\S]*?-->\s*\n)?)/,
				"$1\nNot applicable. Bot screenshots are waived; CI results are attached to this pull request.\n",
			);
	} else {
		body = [
			`${input.summary.trim()}\n\n${origin}`,
			"",
			closes,
			"",
			`AI assistance disclosure: this pull request was generated by ${input.model} via the EmDash bot.`,
		].join("\n");
	}
	return `${body.trim()}\n\n${prMarker(input.identity.caseId)}\n`;
}

/** What the issue's comment becomes once work moves to the pull request. */
export function renderMovedToPullRequest(identity: CaseIdentity, prNumber: number): string {
	return `${statusMarker(identity.caseId)}\nThe EmDash bot's work on this issue continues in #${prNumber}.`;
}
