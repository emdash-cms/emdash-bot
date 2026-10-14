// Classify a completed check run from exact-head evidence before anything
// decides whether it warrants a code repair. Only a supported code failure
// starts author work; everything else keeps the candidate as it is.

import type { CheckPolicy } from "../config.ts";
import type { CheckClassification, VerificationOutcome } from "../cases/types.ts";

export interface CheckEvidence {
	readonly name: string;
	readonly headSha: string;
	readonly conclusion: string | null;
	readonly output: { readonly title?: string; readonly summary?: string; readonly text?: string };
	/** Relevant log excerpt, when the caller fetched one. */
	readonly log?: string;
}

const INFRASTRUCTURE = [
	/\b50[234]\b.*\b(bad gateway|service unavailable|gateway time-?out)\b/i,
	/\b(bad gateway|service unavailable|gateway time-?out)\b/i,
	/\bHTTP(?:\/\d(?:\.\d)?)? 50[0234]\b/i,
	/\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bsocket hang up\b/i,
	/\brate limit(ed)?\b|\bsecondary rate limit\b/i,
	/\brunner (has received a shutdown signal|lost communication)\b/i,
	/\bThe operation was canceled\b.*\btimeout\b/i,
	/\bno space left on device\b/i,
	/\bfailed to download action\b/i,
];

export function outcomeOf(conclusion: string | null): VerificationOutcome {
	switch (conclusion) {
		case "success":
		case "neutral":
			return "succeeded";
		case "skipped":
			return "skipped";
		case "cancelled":
			return "cancelled";
		case null:
			return "running";
		default:
			return "failed";
	}
}

export interface Classification {
	readonly classification: CheckClassification;
	readonly reason: string;
}

export function classifyCheck(
	policy: CheckPolicy,
	evidence: CheckEvidence,
	currentHead: string | null,
): Classification {
	if (currentHead && evidence.headSha !== currentHead) {
		return {
			classification: "stale",
			reason: `ran on ${evidence.headSha.slice(0, 12)}, current head is ${currentHead.slice(0, 12)}`,
		};
	}
	const outcome = outcomeOf(evidence.conclusion);
	if (outcome === "succeeded") return { classification: "success", reason: "check succeeded" };
	if (outcome === "cancelled")
		return { classification: "cancellation", reason: "check was cancelled" };
	if (outcome === "skipped") {
		const rule = policy.skippable?.[evidence.name];
		return rule
			? { classification: "success", reason: `skipped as permitted: ${rule}` }
			: {
					classification: "unknown",
					reason: "required check was skipped without an applicability rule",
				};
	}
	if (policy.administrative.includes(evidence.name) || evidence.conclusion === "action_required") {
		return { classification: "administrative", reason: "administrative or human gate" };
	}
	const haystack = [
		evidence.output.title,
		evidence.output.summary,
		evidence.output.text,
		evidence.log,
	]
		.filter(Boolean)
		.join("\n");
	const infra = INFRASTRUCTURE.find((pattern) => pattern.test(haystack));
	if (infra)
		return {
			classification: "infrastructure",
			reason: `infrastructure failure: ${haystack.match(infra)?.[0] ?? "transient error"}`,
		};
	if (evidence.conclusion === "timed_out")
		return { classification: "infrastructure", reason: "check timed out" };
	if (policy.code.includes(evidence.name)) {
		if (haystack.trim() === "")
			return { classification: "unknown", reason: "code check failed without readable evidence" };
		return { classification: "code", reason: "code check failed on the current head" };
	}
	return {
		classification: "unknown",
		reason: `check ${evidence.name} is not classified by policy`,
	};
}
