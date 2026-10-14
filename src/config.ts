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
}

export interface Budgets {
	readonly setupMs: number;
	readonly authorMs: number;
	readonly jobMs: number;
	readonly caseMs: number;
	readonly tokens: number;
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
	/** Required checks that may be skipped, with the rule that permits it. */
	readonly skippable?: Readonly<Record<string, string>>;
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
	readonly repositories: readonly RepositoryConfig[];
	/** Logins treated as maintainers in addition to OWNER/MEMBER/COLLABORATOR. */
	readonly maintainers: readonly string[];
	/** Logins of the configured independent reviewer. */
	readonly reviewers: readonly string[];
	/** `provider:id` of the author model. */
	readonly authorModel: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	readonly gatewayId?: string;
	readonly budgets: Budgets;
	readonly checks: CheckPolicy;
	readonly githubApiUrl: string;
	readonly gitRemoteBase: string;
	/** Maximum accepted checkpoint artifact size in bytes. */
	readonly maxArtifactBytes: number;
	/** Interval of the case reconciliation heartbeat. */
	readonly reconcileMs: number;
	/** Author and committer of published commits. */
	readonly commitAuthor: { readonly name: string; readonly email: string };
}

export const DEFAULT_BUDGETS: Budgets = {
	setupMs: 15 * 60_000,
	authorMs: 45 * 60_000,
	jobMs: 10 * 60_000,
	caseMs: 6 * 60 * 60_000,
	tokens: 4_000_000,
	rounds: 6,
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
		repositories: raw.repositories ?? [],
		maintainers: raw.maintainers ?? [],
		reviewers: raw.reviewers ?? [],
		authorModel: raw.authorModel,
		thinkingLevel: raw.thinkingLevel,
		gatewayId: raw.gatewayId,
		budgets: { ...DEFAULT_BUDGETS, ...raw.budgets },
		checks: { code: [], administrative: [], required: [], ...raw.checks },
		githubApiUrl: raw.githubApiUrl ?? "https://api.github.com",
		gitRemoteBase: raw.gitRemoteBase ?? "https://github.com",
		maxArtifactBytes: raw.maxArtifactBytes ?? 8 * 1024 * 1024,
		reconcileMs: raw.reconcileMs ?? 15_000,
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
