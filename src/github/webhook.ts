// Pure webhook handling: signature verification and normalization of GitHub
// payloads into case deliveries. Authority comes from the payload's actor and
// the configured allowlists, never from text inside a comment.

import type { BotConfig } from "../config.ts";
import type { CaseIdentity } from "../cases/types.ts";

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
	return crypto.subtle.timingSafeEqual(provided, mac);
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
	issue?: {
		id?: number;
		number?: number;
		title?: string;
		body?: string | null;
		html_url?: string;
		pull_request?: unknown;
		user?: User;
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
	if (same(sender, config.botLogin) && eventName !== "pull_request")
		return { skip: "event from the bot itself" };
	const maintainer = isMaintainer(
		config,
		sender,
		payload.comment?.author_association ?? senderAssociation,
	);

	if (
		eventName === "issues" &&
		(payload.action === "assigned" || payload.action === "unassigned")
	) {
		if (!same(payload.assignee?.login, config.botLogin))
			return { skip: "assignment is not for the bot" };
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
		};
		return payload.action === "assigned"
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

	if (
		eventName === "pull_request" &&
		(payload.action === "assigned" || payload.action === "unassigned")
	) {
		if (!same(payload.assignee?.login, config.botLogin))
			return { skip: "assignment is not for the bot" };
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
		if (payload.action === "unassigned") {
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
		if (!maintainer) return { skip: "comment author is not a maintainer" };
		if (!(comment.body ?? "").toLowerCase().includes(`@${botHandle(config).toLowerCase()}`)) {
			return { skip: "comment does not address the bot" };
		}
		return {
			kind: "direction",
			actor: sender,
			provenance: maintainer,
			route: { aliases: [`number:${issue.number}`] },
			payload: {
				commentId: comment.id,
				body: comment.body ?? "",
				url: comment.html_url ?? "",
				number: issue.number,
			},
		};
	}

	if (eventName === "pull_request_review" && payload.action === "submitted") {
		const review = payload.review;
		const pr = payload.pull_request;
		if (!review?.id || !pr?.number) return { skip: "review payload incomplete" };
		const reviewer = review.user?.login ?? sender;
		if (!config.reviewers.some((r) => same(reviewer, r))) {
			// Human reviews are directions when they come from a maintainer.
			if (maintainer && (review.body ?? "").trim() !== "") {
				return {
					kind: "direction",
					actor: sender,
					provenance: maintainer,
					route: { aliases: [`number:${pr.number}`] },
					payload: {
						reviewId: review.id,
						body: review.body ?? "",
						url: review.html_url ?? "",
						number: pr.number,
					},
				};
			}
			return { skip: `review by ${reviewer} is not from the configured reviewer` };
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
