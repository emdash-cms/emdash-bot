// Adapter for the existing EmDash reviewer. The reviewer emits a
// machine-readable findings block alongside its prose:
//
//   ```emdash-review-findings
//   { "version": 1, "reviewedCommit": "<sha>",
//     "findings": [{ "id": "F1", "severity": "major", "path": "src/a.ts", "line": 10,
//                    "title": "...", "body": "...", "actionable": true }],
//     "dispositions": [{ "id": "F0", "status": "resolved" | "open" | "withdrawn", "note": "..." }] }
//   ```
//
// Finding IDs are stable across rounds; `dispositions` states the reviewer's
// verdict on every earlier finding for the newly reviewed commit.

export interface ReviewFinding {
	readonly id: string;
	/** The inline comment this finding came from, so replies can join its thread. */
	readonly commentId?: number | null;
	readonly severity: string;
	readonly path: string | null;
	readonly line: number | null;
	readonly title: string;
	readonly body: string;
	readonly actionable: boolean;
}

export interface ReviewDisposition {
	readonly id: string;
	readonly status: "resolved" | "open" | "withdrawn";
	readonly note?: string;
}

export interface ParsedReview {
	readonly structured: boolean;
	readonly reviewedCommit: string;
	readonly findings: readonly ReviewFinding[];
	readonly dispositions: readonly ReviewDisposition[];
	/** Inline comments that reply to an existing thread rather than raising something new. */
	readonly replies: readonly ReviewComment[];
}

const BLOCK = /```emdash-review-findings\s*\n([\s\S]*?)\n```/;

/** An inline comment that belongs to the review. */
export interface ReviewComment {
	readonly id: number;
	/** The thread's first comment, when this comment is a reply. */
	readonly inReplyTo?: number | null;
	readonly path: string | null;
	readonly line: number | null;
	readonly body: string;
}

export function parseReview(
	body: string,
	reviewId: number | string,
	commitId: string,
	state: string,
	comments: readonly ReviewComment[] = [],
): ParsedReview {
	const match = BLOCK.exec(body);
	if (match) {
		try {
			const data = JSON.parse(match[1]!) as {
				reviewedCommit?: string;
				findings?: Array<Partial<ReviewFinding> & { id?: string }>;
				dispositions?: Array<Partial<ReviewDisposition>>;
			};
			return {
				structured: true,
				replies: comments.filter((c) => c.inReplyTo),
				reviewedCommit: data.reviewedCommit || commitId,
				findings: (data.findings ?? []).flatMap((f) =>
					f.id
						? [
								{
									id: String(f.id),
									severity: f.severity ?? "unspecified",
									path: f.path ?? null,
									line: typeof f.line === "number" ? f.line : null,
									title: f.title ?? String(f.id),
									body: f.body ?? "",
									actionable: f.actionable ?? f.severity !== "suggestion",
								},
							]
						: [],
				),
				dispositions: (data.dispositions ?? []).flatMap((d) =>
					d.id && (d.status === "resolved" || d.status === "open" || d.status === "withdrawn")
						? [{ id: String(d.id), status: d.status, ...(d.note ? { note: d.note } : {}) }]
						: [],
				),
			};
		} catch {
			// Fall through: an unreadable block is treated like an unstructured review.
		}
	}
	// Without a block, the review body and each inline comment are findings,
	// so no reviewer feedback is dropped.
	const approved = state.toUpperCase() === "APPROVED";
	const findings: ReviewFinding[] = [];
	if (!approved && body.trim() !== "") {
		findings.push({
			id: `review-${reviewId}`,
			severity: "unspecified",
			path: null,
			line: null,
			title: "Reviewer feedback without a findings block",
			body,
			actionable: true,
		});
	}
	for (const comment of comments) {
		if (comment.body.trim() === "" || comment.inReplyTo) continue;
		findings.push({
			id: `review-${reviewId}-c${comment.id}`,
			commentId: comment.id,
			severity: "unspecified",
			path: comment.path,
			line: comment.line,
			title: `Inline comment${comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ""}` : ""}`,
			body: comment.body,
			actionable: !approved,
		});
	}
	return {
		structured: false,
		reviewedCommit: commitId,
		findings,
		dispositions: [],
		replies: comments.filter((c) => c.inReplyTo && c.body.trim() !== ""),
	};
}

/** How many actionable items a review carries, for readiness. */
export function actionableCount(parsed: ParsedReview): number {
	return parsed.findings.filter((f) => f.actionable).length;
}

interface ComparedCommit {
	readonly author?: { readonly login?: string } | null;
	readonly commit?: { readonly message?: string };
}

/** Whether a push added only the repository formatter's commits on top of the previous head. */
export function isFormatOnlyPush(
	rule: { readonly author: string; readonly message: string },
	comparison: { readonly status?: string; readonly commits?: readonly ComparedCommit[] },
): boolean {
	const commits = comparison.commits ?? [];
	return (
		comparison.status === "ahead" &&
		commits.length > 0 &&
		commits.every(
			(c) =>
				c.author?.login === rule.author && c.commit?.message?.split("\n", 1)[0] === rule.message,
		)
	);
}
