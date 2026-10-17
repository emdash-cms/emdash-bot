// Bot configuration. Non-secret settings arrive as one JSON binding
// (`BOT_CONFIG`) so a profile is reviewable in one place; secrets are separate
// bindings and never appear in case records, prompts or logs.

export type Profile = "test" | "staging" | "production";

export interface RepositoryConfig {
	/** Immutable GitHub repository ID. */
	readonly id: number;
	/** `owner/name`, used for API paths. The ID is authoritative. */
	readonly fullName: string;
	/** Commands the author may run as named focused checks. */
	readonly focusedChecks?: Readonly<Record<string, string>>;
	/** One bounded bootstrap command run after a fresh checkout. */
	readonly prepare?: string;
	/** Overrides the global `autoIntake` for this repository. */
	readonly autoIntake?: boolean;
	/** Overrides the check names required for readiness in this repository. */
	readonly requiredChecks?: readonly string[];
	/** Labels applied for changed paths, by path prefix (e.g. `packages/core/` -> `area/core`). */
	readonly areaLabels?: Readonly<Record<string, string>>;
	/**
	 * Commits the repository's formatter pushes to PR branches. A review of their
	 * parent still covers them, since the reviewer does not re-review them.
	 */
	readonly formatCommit?: FormatCommitRule;
	/** Where the repository publishes a preview of a pull request, for the reporter to try. */
	readonly preview?: PreviewConfig;
	/** How to ask the repository's review service for a review when it won't start one itself. */
	readonly review?: ReviewServiceConfig;
}

export interface ReviewServiceConfig {
	/** The label that asks the review service to review the pull request again. */
	readonly label: string;
	/** The check the review service reports on, whose failure means no review is coming. */
	readonly check: string;
}

export interface PreviewConfig {
	/** The check whose success on the head means the preview is up. */
	readonly check: string;
	/** The account whose pull request comment carries `Preview URL: <url>`. */
	readonly commentAuthor: string;
	/** A check whose output lists installable package builds (`npm i <url>`), if any. */
	readonly packagesCheck?: string;
}

export interface FormatCommitRule {
	/** The pusher's login, e.g. `emdashbot[bot]`. */
	readonly author: string;
	/** The commit message's first line, e.g. `style: format`. */
	readonly message: string;
}

export interface Budgets {
	readonly setupMs: number;
	readonly authorMs: number;
	readonly jobMs: number;
	readonly tokens: number;
	/** Messages that may start the author working (assignment, comments, reviews, failing checks). */
	readonly rounds: number;
	readonly cancelMs: number;
}

export interface CheckPolicy {
	/** Check names whose failure is a code failure the author can repair. */
	readonly code: readonly string[];
	/** Check names that are administrative or human gates. */
	readonly administrative: readonly string[];
	/** Check names that must succeed on the exact head for readiness. */
	readonly required: readonly string[];
}

export interface BotConfig {
	readonly profile: Profile;
	/** The bot account as it appears in webhooks, e.g. `emdash-bot-pi[bot]`. */
	readonly botLogin: string;
	/**
	 * Intake: a maintainer assigns this login (a machine user; GitHub Apps
	 * cannot be assignees) or applies `intakeLabel` to a specific issue or PR.
	 */
	readonly assignee: string;
	readonly intakeLabel: string;
	/** Also admit every newly opened issue; the author decides whether to take it on. */
	readonly autoIntake: boolean;
	/** Whether auto-intake also takes issues maintainers open. Off in production; staging tests use it. */
	readonly autoIntakeMaintainers: boolean;
	/** Thresholds for Clef triage of automatically admitted issues. */
	readonly triage: {
		readonly takeOn: number;
		readonly decline: number;
		readonly spam: number;
		readonly actionable: number;
	};
	readonly repositories: readonly RepositoryConfig[];
	/**
	 * Staging only: also admit repositories whose `owner/name` matches this
	 * pattern (disposable evaluation fixtures), with `defaultRepository` settings.
	 * The GitHub App installation remains the second boundary.
	 */
	readonly repositoryPattern?: string;
	readonly defaultRepository?: Omit<RepositoryConfig, "id" | "fullName">;
	/** Logins treated as maintainers in addition to OWNER/MEMBER/COLLABORATOR. */
	readonly maintainers: readonly string[];
	/** Logins of the configured independent reviewer. */
	readonly reviewers: readonly string[];
	/** `provider:id` of the author model. */
	readonly authorModel: string;
	/** Optional helper model for the author's `delegate` tool, `provider:id`. */
	readonly childModel: string | null;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	readonly gatewayId?: string;
	readonly budgets: Budgets;
	readonly checks: CheckPolicy;
	readonly githubApiUrl: string;
	/**
	 * The model for the pre-submit adversarial review; a different family from
	 * the author catches more. Defaults to the author's model.
	 */
	readonly reviewModel?: string;
	/** How many independent reviewers the pre-submit review runs; a second found more in about one run in five. */
	readonly selfReviewers: number;
	/** The first delay before retrying a failed model call; later retries double it. */
	readonly modelRetryBaseMs: number;
	/** The Worker's public origin, for links such as published screenshots. */
	readonly publicUrl: string;
	readonly gitRemoteBase: string;
	/** Maximum accepted checkpoint artifact size in bytes. */
	readonly maxArtifactBytes: number;
	/** Model request retries for transient provider errors such as capacity limits. */
	readonly modelRetry: {
		readonly maxRetries: number;
		readonly baseDelayMs: number;
		readonly maxAgentDelayMs: number;
	};
	/** Author rounds that may run at once per repository (the plan starts live operation at one). */
	readonly maxActiveAuthors: number;
	/** Interval of the case reconciliation heartbeat. */
	readonly reconcileMs: number;
	/** Quiet period before failing checks on a head go to the author as one message. */
	readonly checkSettleMs: number;
	/** Retry interval for forwarding a recorded delivery to its case. */
	readonly deliveryRetryMs: number;
	/** Failed forwarding attempts after which a case is reported unavailable. */
	readonly unavailableAfterAttempts: number;
	/** How long deliveries are kept for inspection and deduplication: unrouted ones (CI noise) and the rest. */
	readonly deliveryRetention: {
		readonly unroutedMs: number;
		readonly routedMs: number;
		readonly pruneEveryMs: number;
	};
	/** Author and committer of published commits. */
	readonly commitAuthor: { readonly name: string; readonly email: string };
}

export const DEFAULT_BUDGETS: Budgets = {
	setupMs: 15 * 60_000,
	authorMs: 45 * 60_000,
	jobMs: 10 * 60_000,
	// A real fix with review rounds used 4.7M on its first pass; these are runaway guards, not targets.
	tokens: 20_000_000,
	rounds: 100,
	cancelMs: 60_000,
};

export function readConfig(env: { BOT_CONFIG?: unknown }): BotConfig {
	const raw = (typeof env.BOT_CONFIG === "string" ? JSON.parse(env.BOT_CONFIG) : env.BOT_CONFIG) as
		| Partial<BotConfig>
		| undefined;
	if (!raw || typeof raw !== "object") throw new Error("BOT_CONFIG is not configured");
	const profile = raw.profile ?? "staging";
	if (!["test", "staging", "production"].includes(profile)) throw new Error("invalid profile");
	if (!raw.botLogin) throw new Error("BOT_CONFIG.botLogin is required");
	if (!raw.authorModel?.includes(":"))
		throw new Error("BOT_CONFIG.authorModel must be provider:id");
	return {
		profile,
		botLogin: raw.botLogin,
		assignee: raw.assignee ?? raw.botLogin,
		intakeLabel: raw.intakeLabel ?? "emdash-bot",
		autoIntake: raw.autoIntake ?? false,
		autoIntakeMaintainers: raw.autoIntakeMaintainers ?? false,
		triage: { takeOn: 0.6, decline: 0.6, spam: 0.5, actionable: 0.5, ...raw.triage },
		repositories: raw.repositories ?? [],
		repositoryPattern: profile === "production" ? undefined : raw.repositoryPattern,
		defaultRepository: raw.defaultRepository,
		maintainers: raw.maintainers ?? [],
		reviewers: raw.reviewers ?? [],
		authorModel: raw.authorModel,
		childModel: raw.childModel ?? null,
		thinkingLevel: raw.thinkingLevel,
		gatewayId: raw.gatewayId,
		budgets: { ...DEFAULT_BUDGETS, ...raw.budgets },
		checks: { code: [], administrative: [], required: [], ...raw.checks },
		githubApiUrl: raw.githubApiUrl ?? "https://api.github.com",
		publicUrl: (raw.publicUrl ?? "").replace(/\/$/, ""),
		modelRetryBaseMs: raw.modelRetryBaseMs ?? 2 * 60_000,
		...(raw.reviewModel ? { reviewModel: raw.reviewModel } : {}),
		selfReviewers: raw.selfReviewers ?? 1,
		gitRemoteBase: raw.gitRemoteBase ?? "https://github.com",
		maxArtifactBytes: raw.maxArtifactBytes ?? 8 * 1024 * 1024,
		reconcileMs: raw.reconcileMs ?? 15_000,
		checkSettleMs: raw.checkSettleMs ?? 60_000,
		deliveryRetryMs: raw.deliveryRetryMs ?? 15_000,
		unavailableAfterAttempts: raw.unavailableAfterAttempts ?? 12,
		deliveryRetention: {
			unroutedMs: 24 * 60 * 60_000,
			routedMs: 30 * 24 * 60 * 60_000,
			pruneEveryMs: 60 * 60_000,
			...raw.deliveryRetention,
		},
		maxActiveAuthors: raw.maxActiveAuthors ?? 1,
		modelRetry: { maxRetries: 8, baseDelayMs: 5_000, maxAgentDelayMs: 120_000, ...raw.modelRetry },
		commitAuthor: raw.commitAuthor ?? {
			name: raw.botLogin,
			email: `${raw.botLogin}@users.noreply.github.com`,
		},
	};
}

export function parseModelRef(ref: string): { provider: string; id: string } {
	const at = ref.indexOf(":");
	return { provider: ref.slice(0, at), id: ref.slice(at + 1) };
}

/** Fault injection exists only outside production. */
export function faultsEnabled(config: BotConfig): boolean {
	return config.profile !== "production";
}

/** The repository settings for an admitted repository, or undefined when it is not allowed. */
export function repositoryFor(
	config: BotConfig,
	id: number | undefined,
	fullName: string | undefined,
): RepositoryConfig | undefined {
	if (id === undefined || !fullName) return undefined;
	const listed = config.repositories.find((r) => r.id === id);
	if (listed) return listed.fullName.toLowerCase() === fullName.toLowerCase() ? listed : undefined;
	if (config.repositoryPattern && new RegExp(config.repositoryPattern).test(fullName)) {
		return { ...config.defaultRepository, id, fullName };
	}
	return undefined;
}
