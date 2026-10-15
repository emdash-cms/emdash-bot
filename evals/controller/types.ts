export interface CaseManifest {
	readonly id: string;
	readonly kind: "fix" | "revision" | "delivery" | "negative";
	readonly behaviour: string;
	readonly source: {
		readonly repo?: string;
		readonly startingCommit?: string;
		readonly template?: string;
	};
	readonly issue: { readonly title: string; readonly body: string; readonly sourceUrl: string };
	readonly originalCandidate?: {
		readonly commit: string;
		readonly parent: string;
		readonly reviews: ReadonlyArray<{
			readonly id: number;
			readonly state: string;
			readonly commitId: string;
			readonly body: string;
		}>;
	};
	readonly fixtureModel?: string;
	readonly script?: unknown;
	readonly faults?: readonly string[];
	readonly faultMatrix?: readonly string[];
	readonly acceptableOutcome: "fix" | "handoff" | "request-information";
	readonly budget: {
		readonly rounds: number;
		readonly authorMinutes: number;
		readonly caseMinutes: number;
	};
}

export interface GraderManifest {
	readonly id: string;
	readonly status: "unvalidated" | "validated" | "not-reproducible";
	readonly referenceCommit?: string;
	readonly tests: readonly string[];
	readonly setup: readonly string[];
	readonly commands: readonly string[];
	readonly note?: string;
}

export interface Profile {
	readonly name: string;
	readonly url: string;
	readonly owner: string;
	/** Fixture repositories are `${owner}/${repoPrefix}${case}`. */
	readonly repoPrefix: string;
	readonly intakeLabel: string;
	/** Login that posts seeded reviews; must be a configured reviewer on the staging Worker. */
	readonly reviewActor: string;
	readonly emdashCheckout: string;
	readonly pollMs: number;
}

export type Stage =
	| "created"
	| "provisioned"
	| "seeded"
	| "triggered"
	| "observing"
	| "settled"
	| "graded"
	| "written";

export type Outcome =
	| "ready-for-human"
	| "needs-human"
	| "waiting-for-reply"
	| "declined"
	| "changes-required"
	| "waiting"
	| "cancelled"
	| "timed-out"
	| "failed-to-start";

export interface AttemptState {
	readonly attemptId: string;
	readonly caseId: string;
	readonly profile: string;
	readonly fault: string | null;
	stage: Stage;
	repo?: { fullName: string; id: number };
	issueNumber?: number;
	prNumber?: number;
	botCaseId?: string;
	triggeredAt?: number;
	deadline?: number;
	outcome?: Outcome;
	settledAt?: number;
	history: Array<{ at: number; stage: Stage; note?: string }>;
	manifest?: Record<string, unknown>;
}
