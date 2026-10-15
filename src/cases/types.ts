export type CaseKind = "issue" | "pr";

export interface CaseIdentity {
	readonly caseId: string;
	readonly repoId: number;
	readonly repo: string;
	readonly kind: CaseKind;
	readonly issueId?: number;
	readonly issueNumber?: number;
	readonly prId?: number;
	readonly prNumber?: number;
	/** The branch the case publishes to. */
	readonly branch: string;
	/** True when the bot created the branch; false for an adopted contributor branch. */
	readonly ownsBranch: boolean;
	/** The default branch whose instructions govern the case. */
	readonly defaultBranch: string;
}

export type CaseState = "active" | "cancelled" | "declined" | "terminal";

export type CaseStatus =
	| "working"
	| "candidate-published"
	| "waiting-for-checks"
	| "changes-required"
	| "ready-for-human"
	| "needs-human"
	| "cancelled"
	| "declined"
	| "terminal";

export interface CaseEvent {
	readonly seq: number;
	readonly deliveryId: string;
	readonly kind: string;
	readonly actor: string;
	/** How the actor's authority was established. */
	readonly provenance: string;
	readonly payload: Record<string, unknown>;
	readonly receivedAt: number;
	readonly consumedRound: number | null;
}

export interface CheckpointRow {
	readonly id: string;
	readonly seq: number;
	readonly opId: string;
	readonly baseCommit: string;
	readonly treeHash: string;
	readonly digest: string;
	readonly artifactKey: string;
	readonly size: number;
	readonly generation: number;
	readonly createdAt: number;
}

export interface Candidate {
	readonly id: string;
	readonly caseId: string;
	readonly ownershipGeneration: number;
	readonly parentCandidateId: string | null;
	readonly sourceBaseCommit: string;
	readonly expectedBranchHead: string | null;
	readonly sourceTreeHash: string;
	readonly artifactDigest: string;
	readonly artifactKey: string;
	readonly requirementsRevision: number;
	readonly checkpointId: string;
	readonly title: string;
	readonly summary: string;
	readonly origin: "author" | "integration";
	readonly createdAt: number;
}

export type PublicationState =
	| "intent"
	| "commit-created"
	| "ref-updated"
	| "pr-ensured"
	| "needs-human"
	| "failed"
	| "superseded";

export interface Publication {
	readonly opId: string;
	readonly candidateId: string;
	readonly branch: string;
	readonly expectedHead: string | null;
	readonly parentCommit: string;
	readonly treeSha: string;
	readonly message: string;
	readonly authorDate: string;
	readonly state: PublicationState;
	readonly commitSha: string | null;
	readonly prNumber: number | null;
	readonly prId: number | null;
	readonly error: string | null;
	readonly attempts: number;
	readonly updatedAt: number;
}

export type VerificationOutcome =
	| "queued"
	| "running"
	| "cancelled"
	| "skipped"
	| "failed"
	| "succeeded"
	| "interrupted";
export type CheckClassification =
	| "code"
	| "infrastructure"
	| "administrative"
	| "cancellation"
	| "stale"
	| "unknown"
	| "success";

export interface Verification {
	readonly id: string;
	readonly candidateId: string | null;
	readonly treeHash: string | null;
	readonly commitSha: string | null;
	readonly name: string;
	readonly kind: "sandbox" | "workflow";
	readonly environment: string;
	readonly outcome: VerificationOutcome;
	readonly classification: CheckClassification | null;
	readonly startedAt: number;
	readonly completedAt: number | null;
	readonly details: Record<string, unknown>;
}

export type FindingStatus =
	| "open"
	| "addressed-by-author"
	| "confirmed-by-reviewer"
	| "disputed"
	| "needs-human";

export interface Finding {
	readonly id: string;
	readonly reviewId: string;
	readonly reviewedCommit: string;
	readonly path: string | null;
	readonly line: number | null;
	readonly severity: string;
	readonly title: string;
	readonly body: string;
	readonly actionable: boolean;
	readonly status: FindingStatus;
	readonly authorNote: string | null;
	readonly updatedAt: number;
	readonly history: ReadonlyArray<{
		at: number;
		status: FindingStatus;
		by: string;
		note?: string;
		commit?: string;
	}>;
}

export interface Requirement {
	readonly revision: number;
	readonly source: string;
	readonly actor: string;
	readonly body: string;
	readonly createdAt: number;
}

export interface ReviewRecord {
	readonly reviewId: string;
	readonly reviewer: string;
	readonly commit: string;
	readonly state: string;
	readonly structured: boolean;
	/** Actionable items in the review: findings-block entries, or the body and inline comments. */
	readonly actionable: number;
	readonly receivedAt: number;
}

/** A reply the author asked trusted code to post. */
export interface ReplyIntent {
	readonly key: string;
	/** Review comment to reply under; null posts a top-level comment on `target`. */
	readonly inReplyTo: number | null;
	readonly target: "pr" | "issue";
	readonly body: string;
	readonly generation: number;
	readonly status: "pending" | "posted" | "dropped";
	readonly postedCommentId: number | null;
	readonly createdAt: number;
}
