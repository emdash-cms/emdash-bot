// Pure webhook handling: signature verification and normalization of GitHub
// payloads into case deliveries. Authority comes from the payload's actor and
// the configured allowlists, never from text inside a comment.

import { type BotConfig, repositoryFor } from "../config.ts";
import type { CaseIdentity } from "../cases/types.ts";

import { constantTimeEqual } from "../util.ts";
import { STATUS_CHECK_NAME } from "../reports/render.ts";

const encoder = new TextEncoder();

export async function verifySignature(
	secret: string,
	body: string,
	header: string | null,
): Promise<boolean> {
	if (!header?.startsWith("sha256=")) return false;
	const hex = header.slice(7);
	if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
	const provided = Uint8Array.from(hex.match(/../g)!, (h) => Number.parseInt(h, 16));
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
	return constantTimeEqual(provided, mac);
}

export async function sign(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
	return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type DeliveryKind =
	| "assigned"
	| "unassigned"
	| "direction"
	| "comment"
	| "maintainer-review"
	| "review"
	| "check"
	| "head-changed"
	| "pr-opened"
	| "closed";

export interface NormalizedDelivery {
	readonly kind: DeliveryKind;
	readonly actor: string;
	readonly provenance: string;
	/** Create a case (assignment) or route through aliases. */
	readonly route: { readonly create: CaseIdentity } | { readonly aliases: readonly string[] };
	readonly payload: Record<string, unknown>;
}

export type Normalized = NormalizedDelivery | { readonly skip: string };

interface User {
	login?: string;
	type?: string;
}
interface Repo {
	id?: number;
	full_name?: string;
	default_branch?: string;
}
interface Payload {
	action?: string;
	sender?: User;
	repository?: Repo;
	assignee?: User;
	label?: { name?: string };
	issue?: {
		id?: number;
		number?: number;
		title?: string;
		body?: string | null;
		html_url?: string;
		pull_request?: unknown;
		user?: User;
		author_association?: string;
	};
	comment?: {
		id?: number;
		body?: string | null;
		user?: User;
		author_association?: string;
		html_url?: string;
	};
	pull_request?: {
		id?: number;
		number?: number;
		title?: string;
		body?: string | null;
		html_url?: string;
		user?: User;
		merged?: boolean;
		author_association?: string;
		head?: { ref?: string; sha?: string; repo?: Repo | null };
		base?: { ref?: string; repo?: Repo };
	};
	review?: {
		id?: number;
		body?: string | null;
		commit_id?: string;
		state?: string;
		user?: User;
		html_url?: string;
	};
	check_run?: {
		id?: number;
		name?: string;
		head_sha?: string;
		status?: string;
		conclusion?: string | null;
		html_url?: string;
		details_url?: string;
		started_at?: string;
		completed_at?: string;
		output?: { title?: string | null; summary?: string | null; text?: string | null };
		app?: { slug?: string };
		check_suite?: { head_branch?: string | null };
		pull_requests?: Array<{ number?: number }>;
	};
	before?: string;
	after?: string;
}

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isMaintainer(
	config: BotConfig,
	login: string | undefined,
	association: string | undefined,
): string | null {
	if (!login || login.endsWith("[bot]")) return null;
	if (config.maintainers.some((m) => m.toLowerCase() === login.toLowerCase()))
		return "maintainer:configured";
	if (association && MAINTAINER_ASSOCIATIONS.has(association.toUpperCase()))
		return `maintainer:association=${association.toUpperCase()}`;
	return null;
}

function same(a: string | undefined, b: string): boolean {
	return !!a && a.toLowerCase() === b.toLowerCase();
}

/** Whether an event assigns or unassigns the bot, through assignment or the intake label. */
function intakeAction(
	config: BotConfig,
	payload: Payload,
): "assign" | "unassign" | "not-for-bot" | null {
	const action = payload.action;
	if (action === "assigned" || action === "unassigned") {
		if (
			!same(payload.assignee?.login, config.assignee) &&
			!same(payload.assignee?.login, config.botLogin)
		)
			return "not-for-bot";
		return action === "assigned" ? "assign" : "unassign";
	}
	if (action === "labeled" || action === "unlabeled") {
		if (!same(payload.label?.name, config.intakeLabel)) return null;
		return action === "labeled" ? "assign" : "unassign";
	}
	return null;
}

export function botHandle(config: BotConfig): string {
	return config.botLogin.replace(/\[bot\]$/, "");
}

export function caseIdFor(repoId: number, kind: "issue" | "pr", entityId: number): string {
	return `${repoId}-${kind}-${entityId}`;
}

export function botBranch(issueNumber: number): string {
	return `emdash-bot/issue-${issueNumber}`;
}

/**
 * Normalize one webhook. `senderAssociation` is the sender's repository
 * association, resolved by the caller for events that do not carry it.
 */
export function normalize(
	config: BotConfig,
	eventName: string,
	payload: Payload,
	senderAssociation?: string,
): Normalized {
	const repo = payload.repository;
	if (!repo?.id || !repo.full_name) return { skip: "payload has no repository" };
	const sender = payload.sender?.login ?? "";
	// The bot's own comments and reviews must never become instructions. Check
	// runs and pull request events name the bot as sender when it pushed the
	// commit, and still carry evidence the case needs.
	if (same(sender, config.botLogin) && eventName !== "pull_request" && eventName !== "check_run")
		return { skip: "event from the bot itself" };
	const maintainer = isMaintainer(
		config,
		sender,
		payload.comment?.author_association ?? senderAssociation,
	);
	const intake = intakeAction(config, payload);

	const autoIntake =
		repositoryFor(config, repo.id, repo.full_name)?.autoIntake ?? config.autoIntake;
	if (eventName === "issues" && payload.action === "opened" && autoIntake) {
		const issue = payload.issue;
		if (!issue?.id || !issue.number) return { skip: "issue payload incomplete" };
		if (sender.endsWith("[bot]"))
			return { skip: "issues opened by bots are not taken on automatically" };
		const openerIsMaintainer = isMaintainer(config, sender, issue.author_association) !== null;
		// Maintainers assign the bot explicitly when they want it on their own issues.
		if (openerIsMaintainer && !config.autoIntakeMaintainers)
			return { skip: "issues opened by maintainers are not taken on automatically" };
		// Repository policy admits the issue; the opener gains no maintainer authority.
		return {
			kind: "assigned",
			actor: sender,
			provenance: "auto-intake",
			route: {
				create: {
					caseId: caseIdFor(repo.id, "issue", issue.id),
					repoId: repo.id,
					repo: repo.full_name,
					kind: "issue",
					issueId: issue.id,
					issueNumber: issue.number,
					branch: botBranch(issue.number),
					ownsBranch: true,
					defaultBranch: repo.default_branch ?? "main",
				},
			},
			payload: {
				number: issue.number,
				title: issue.title ?? "",
				body: issue.body ?? "",
				url: issue.html_url ?? "",
				reporter: issue.user?.login ?? sender,
				autoIntake: true,
				openerIsMaintainer,
			},
		};
	}

	if (eventName === "issues" && intake) {
		if (intake === "not-for-bot") return { skip: "assignment or label is not for the bot" };
		if (!maintainer) return { skip: `assignment by ${sender} without maintainer authority` };
		const issue = payload.issue;
		if (!issue?.id || !issue.number) return { skip: "issue payload incomplete" };
		const identity: CaseIdentity = {
			caseId: caseIdFor(repo.id, "issue", issue.id),
			repoId: repo.id,
			repo: repo.full_name,
			kind: "issue",
			issueId: issue.id,
			issueNumber: issue.number,
			branch: botBranch(issue.number),
			ownsBranch: true,
			defaultBranch: repo.default_branch ?? "main",
		};
		const body = {
			number: issue.number,
			title: issue.title ?? "",
			body: issue.body ?? "",
			url: issue.html_url ?? "",
			reporter: issue.user?.login ?? "",
		};
		return intake === "assign"
			? {
					kind: "assigned",
					actor: sender,
					provenance: maintainer,
					route: { create: identity },
					payload: body,
				}
			: {
					kind: "unassigned",
					actor: sender,
					provenance: maintainer,
					route: { aliases: [`number:${issue.number}`] },
					payload: body,
				};
	}

	if (eventName === "pull_request" && intake) {
		if (intake === "not-for-bot") return { skip: "assignment or label is not for the bot" };
		if (!maintainer) return { skip: `assignment by ${sender} without maintainer authority` };
		const pr = payload.pull_request;
		if (!pr?.id || !pr.number || !pr.head?.ref) return { skip: "pull request payload incomplete" };
		const body = {
			number: pr.number,
			title: pr.title ?? "",
			body: pr.body ?? "",
			url: pr.html_url ?? "",
			headSha: pr.head.sha ?? "",
		};
		if (intake === "unassign") {
			return {
				kind: "unassigned",
				actor: sender,
				provenance: maintainer,
				route: { aliases: [`number:${pr.number}`] },
				payload: body,
			};
		}
		if (pr.head.repo?.id !== repo.id)
			return { skip: "pull requests from forks are not adopted; hand off to a human" };
		const identity: CaseIdentity = {
			caseId: caseIdFor(repo.id, "pr", pr.id),
			repoId: repo.id,
			repo: repo.full_name,
			kind: "pr",
			prId: pr.id,
			prNumber: pr.number,
			branch: pr.head.ref,
			ownsBranch: same(pr.user?.login, config.botLogin),
			defaultBranch: repo.default_branch ?? "main",
		};
		return {
			kind: "assigned",
			actor: sender,
			provenance: maintainer,
			route: { create: identity },
			payload: body,
		};
	}

	if (eventName === "issue_comment" && payload.action === "created") {
		const issue = payload.issue;
		const comment = payload.comment;
		if (!issue?.number || !comment?.id) return { skip: "comment payload incomplete" };
		// Comments are conversation: the author reads them with its judgement, as a
		// human would. Only maintainers and the configured reviewer are heard.
		const reviewerComment = config.reviewers.some((r) => same(sender, r));
		// The reporter of the original issue is heard on that issue, without maintainer authority.
		const reporter =
			!issue.pull_request && same(issue.user?.login, sender) && !sender.endsWith("[bot]");
		if (!maintainer && !reviewerComment && !reporter)
			return {
				skip: "comment author is not a maintainer, the configured reviewer or the reporter",
			};
		return {
			kind: "comment",
			actor: sender,
			provenance: maintainer ?? (reviewerComment ? "reviewer:configured" : "reporter"),
			route: { aliases: [`number:${issue.number}`] },
			payload: {
				commentId: comment.id,
				body: comment.body ?? "",
				url: comment.html_url ?? "",
				number: issue.number,
				isPullRequest: issue.pull_request !== undefined,
			},
		};
	}

	if (eventName === "pull_request_review" && payload.action === "submitted") {
		const review = payload.review;
		const pr = payload.pull_request;
		if (!review?.id || !pr?.number) return { skip: "review payload incomplete" };
		const reviewer = review.user?.login ?? sender;
		if (!config.reviewers.some((r) => same(reviewer, r))) {
			// A maintainer's review: its state is a signal, its text is conversation.
			if (!maintainer)
				return {
					skip: `review by ${reviewer} is from neither the configured reviewer nor a maintainer`,
				};
			return {
				kind: "maintainer-review",
				actor: sender,
				provenance: maintainer,
				route: { aliases: [`number:${pr.number}`] },
				payload: {
					reviewId: review.id,
					body: review.body ?? "",
					commitId: review.commit_id ?? "",
					state: review.state ?? "",
					url: review.html_url ?? "",
					number: pr.number,
				},
			};
		}
		return {
			kind: "review",
			actor: reviewer,
			provenance: "reviewer:configured",
			route: { aliases: [`number:${pr.number}`] },
			payload: {
				reviewId: review.id,
				body: review.body ?? "",
				commitId: review.commit_id ?? "",
				state: review.state ?? "",
				url: review.html_url ?? "",
				number: pr.number,
			},
		};
	}

	if (eventName === "check_run" && payload.action === "completed") {
		const run = payload.check_run;
		if (!run?.id || !run.head_sha) return { skip: "check run payload incomplete" };
		if (run.name === STATUS_CHECK_NAME) return { skip: "the bot's own status check" };
		const aliases = [
			...(run.pull_requests ?? []).flatMap((p) => (p.number ? [`number:${p.number}`] : [])),
			...(run.check_suite?.head_branch ? [`branch:${run.check_suite.head_branch}`] : []),
		];
		if (aliases.length === 0) return { skip: "check run is not attached to a branch" };
		return {
			kind: "check",
			actor: run.app?.slug ?? "github",
			provenance: "github:check_run",
			route: { aliases },
			payload: {
				checkRunId: run.id,
				name: run.name ?? "",
				headSha: run.head_sha,
				status: run.status ?? "completed",
				conclusion: run.conclusion ?? null,
				url: run.html_url ?? run.details_url ?? "",
				startedAt: run.started_at ?? null,
				completedAt: run.completed_at ?? null,
				output: {
					title: run.output?.title ?? "",
					summary: run.output?.summary ?? "",
					text: run.output?.text ?? "",
				},
			},
		};
	}

	if (eventName === "pull_request") {
		const pr = payload.pull_request;
		if (!pr?.id || !pr.number) return { skip: "pull request payload incomplete" };
		const aliases = [`number:${pr.number}`, ...(pr.head?.ref ? [`branch:${pr.head.ref}`] : [])];
		if (payload.action === "opened" || payload.action === "reopened") {
			return {
				kind: "pr-opened",
				actor: sender,
				provenance: same(sender, config.botLogin) ? "bot" : "github:pull_request",
				route: { aliases },
				payload: {
					prId: pr.id,
					number: pr.number,
					headSha: pr.head?.sha ?? "",
					url: pr.html_url ?? "",
				},
			};
		}
		if (same(sender, config.botLogin)) return { skip: "pull request event from the bot itself" };
		if (payload.action === "synchronize") {
			return {
				kind: "head-changed",
				actor: sender,
				provenance: maintainer ?? "github:pull_request",
				route: { aliases },
				payload: {
					number: pr.number,
					before: payload.before ?? "",
					after: payload.after ?? pr.head?.sha ?? "",
				},
			};
		}
		if (payload.action === "closed") {
			return {
				kind: "closed",
				actor: sender,
				provenance: "github:pull_request",
				route: { aliases },
				payload: { number: pr.number, merged: pr.merged === true },
			};
		}
	}

	if (eventName === "issues" && payload.action === "closed" && payload.issue?.number) {
		return {
			kind: "closed",
			actor: sender,
			provenance: "github:issues",
			route: { aliases: [`number:${payload.issue.number}`] },
			payload: { number: payload.issue.number, merged: false, issue: true },
		};
	}

	return { skip: `unhandled event ${eventName}.${payload.action ?? ""}` };
}
