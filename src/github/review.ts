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
}

const BLOCK = /```emdash-review-findings\s*\n([\s\S]*?)\n```/;

export function parseReview(
	body: string,
	reviewId: number | string,
	commitId: string,
	state: string,
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
	const actionable = state.toUpperCase() !== "APPROVED" && body.trim() !== "";
	return {
		structured: false,
		reviewedCommit: commitId,
		findings: actionable
			? [
					{
						id: `review-${reviewId}`,
						severity: "unspecified",
						path: null,
						line: null,
						title: "Reviewer feedback without a findings block",
						body,
						actionable: true,
					},
				]
			: [],
		dispositions: [],
	};
}
