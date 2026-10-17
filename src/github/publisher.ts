// Trusted publication of a sealed candidate. Every GitHub effect is preceded
// by a durable intent; recovery reconciles remote state before retrying, and
// publication never re-enters the author.
//
// The candidate artifact is materialized in a fresh sandbox that has run no
// candidate code; the tree GitHub builds from its blobs must equal the sealed
// tree hash before any commit is created.

import type { BotConfig } from "../config.ts";
import type { CaseStore } from "../cases/store.ts";
import type { Candidate, CaseIdentity, Publication } from "../cases/types.ts";
import type { ExecBackend } from "../execution/backend.ts";
import {
	materialize,
	mergeTreeApply,
	prepareCheckout,
	fetchCommit,
	stagedChanges,
} from "../source/workspace.ts";
import { sha256Hex } from "../util.ts";
import { GitHubError, type GitHubClient } from "./client.ts";
import { prMarker, renderPullRequestBody } from "../reports/render.ts";

export interface PublishContext {
	readonly store: CaseStore;
	readonly identity: CaseIdentity;
	readonly config: BotConfig;
	readonly github: GitHubClient;
	readonly artifacts: R2Bucket;
	readonly generation: number;
	openSandbox(name: string): ExecBackend;
	fault(boundary: string): Promise<void>;
	registerAlias(alias: string): Promise<void>;
	pullRequestTemplate(): Promise<string | null>;
	/** The maintainer who assigned the case; null when the bot took it on automatically. */
	readonly assignedBy: string | null;
	readonly model: string;
	/** Seal a candidate produced by trusted integration. */
	sealIntegration(
		parent: Candidate,
		base: string,
		patch: Uint8Array,
		treeHash: string,
	): Promise<Candidate>;
}

export type PublishResult =
	| { readonly state: "published"; readonly commitSha: string; readonly prNumber: number }
	| { readonly state: "integrated"; readonly candidate: Candidate }
	| { readonly state: "needs-human"; readonly reason: string }
	| { readonly state: "superseded"; readonly reason: string };

export async function readArtifact(
	artifacts: R2Bucket,
	key: string,
	digest: string,
): Promise<Uint8Array> {
	const object = await artifacts.get(key);
	if (!object) throw new Error(`artifact ${key} is missing`);
	const bytes = new Uint8Array(await object.arrayBuffer());
	if ((await sha256Hex(bytes)) !== digest)
		throw new Error(`artifact ${key} does not match its digest`);
	return bytes;
}

function remoteUrl(config: BotConfig, repo: string): string {
	return `${config.gitRemoteBase}/${repo}.git`;
}

function save(
	ctx: PublishContext,
	publication: Publication,
	patch: Partial<Publication>,
): Publication {
	const next = { ...publication, ...patch, updatedAt: Date.now() };
	ctx.store.putPublication(next);
	return next;
}

function commitMessage(identity: CaseIdentity, candidate: Candidate): string {
	return `${candidate.title}\n\n${candidate.summary.trim()}\n\nEmDash-Bot-Case: ${identity.caseId}\nEmDash-Bot-Candidate: ${candidate.id}\n`;
}

async function buildTree(
	ctx: PublishContext,
	candidate: Candidate,
	patch: Uint8Array,
): Promise<string> {
	const exists = await ctx.github.raw(
		"GET",
		ctx.github.repoPath(`/git/trees/${candidate.sourceTreeHash}`),
	);
	if (exists.status === 200) return candidate.sourceTreeHash;
	const sandbox = ctx.openSandbox(`publish-${candidate.id}`);
	try {
		await prepareCheckout(sandbox, {
			remoteUrl: remoteUrl(ctx.config, ctx.identity.repo),
			baseCommit: candidate.sourceBaseCommit,
			timeoutMs: ctx.config.budgets.setupMs,
		});
		const tree = await materialize(sandbox, candidate.sourceBaseCommit, patch);
		if (tree !== candidate.sourceTreeHash) {
			throw new IntegrityError(
				`clean materialization produced tree ${tree}, sealed tree is ${candidate.sourceTreeHash}`,
			);
		}
		const changes = await stagedChanges(sandbox, candidate.sourceBaseCommit);
		const entries = [];
		for (const change of changes) {
			if (change.content === null) {
				entries.push({ path: change.path, mode: change.mode, type: "blob", sha: null });
				continue;
			}
			let binary = "";
			for (let i = 0; i < change.content.length; i += 0x8000)
				binary += String.fromCharCode(...change.content.subarray(i, i + 0x8000));
			const blob = await ctx.github.request<{ sha: string }>(
				"POST",
				ctx.github.repoPath("/git/blobs"),
				{ content: btoa(binary), encoding: "base64" },
			);
			entries.push({ path: change.path, mode: change.mode, type: "blob", sha: blob.sha });
		}
		const baseTree = await ctx.github.commitTree(candidate.sourceBaseCommit);
		const created = await ctx.github.request<{ sha: string }>(
			"POST",
			ctx.github.repoPath("/git/trees"),
			{ base_tree: baseTree, tree: entries },
		);
		if (created.sha !== candidate.sourceTreeHash) {
			throw new IntegrityError(
				`GitHub tree ${created.sha} does not match sealed tree ${candidate.sourceTreeHash}`,
			);
		}
		return created.sha;
	} finally {
		await sandbox.destroy().catch(() => undefined);
	}
}

class IntegrityError extends Error {}

/**
 * A candidate normally sits on the branch head. One whose base is a newer
 * default-branch head (the author merged it in) publishes as a merge commit of
 * the branch head and that base, as GitHub's "Update branch" does.
 */
export function commitParents(publication: Pick<Publication, "expectedHead" | "parentCommit">) {
	return publication.expectedHead && publication.expectedHead !== publication.parentCommit
		? [publication.expectedHead, publication.parentCommit]
		: [publication.parentCommit];
}

async function integrate(
	ctx: PublishContext,
	candidate: Candidate,
	patch: Uint8Array,
	head: string,
): Promise<PublishResult> {
	if (candidate.origin === "integration") {
		return {
			state: "needs-human",
			reason: `the branch advanced again to ${head.slice(0, 12)} during integration`,
		};
	}
	if (candidate.expectedBranchHead && candidate.sourceBaseCommit !== candidate.expectedBranchHead) {
		return {
			state: "needs-human",
			reason: `the branch advanced to ${head.slice(0, 12)} while a merge of the default branch was waiting to publish`,
		};
	}
	const sandbox = ctx.openSandbox(`integrate-${candidate.id}`);
	try {
		await prepareCheckout(sandbox, {
			remoteUrl: remoteUrl(ctx.config, ctx.identity.repo),
			baseCommit: candidate.sourceBaseCommit,
			timeoutMs: ctx.config.budgets.setupMs,
		});
		await fetchCommit(
			sandbox,
			remoteUrl(ctx.config, ctx.identity.repo),
			head,
			ctx.config.budgets.setupMs,
		);
		const merged = await mergeTreeApply(sandbox, head, patch);
		if (!merged.clean)
			return {
				state: "needs-human",
				reason: `the branch advanced to ${head.slice(0, 12)} and the candidate does not apply cleanly: ${merged.detail}`,
			};
		const next = await ctx.sealIntegration(candidate, head, merged.patch, merged.treeHash);
		return { state: "integrated", candidate: next };
	} finally {
		await sandbox.destroy().catch(() => undefined);
	}
}

async function findPullRequest(
	ctx: PublishContext,
): Promise<{ number: number; id: number; state: string; merged: boolean } | null> {
	const owner = ctx.identity.repo.split("/")[0];
	const pulls = await ctx.github.request<
		Array<{
			number: number;
			id: number;
			state: string;
			merged_at: string | null;
			body: string | null;
		}>
	>(
		"GET",
		ctx.github.repoPath(
			`/pulls?state=all&per_page=50&head=${encodeURIComponent(`${owner}:${ctx.identity.branch}`)}`,
		),
	);
	const marker = prMarker(ctx.identity.caseId);
	const ours = pulls.filter((p) => (p.body ?? "").includes(marker));
	const open =
		ours.find((p) => p.state === "open") ??
		pulls.find((p) => p.state === "open" && (p.body ?? "").includes("emdash-bot:case="));
	const pick = open ?? ours[0];
	return pick
		? { number: pick.number, id: pick.id, state: pick.state, merged: pick.merged_at !== null }
		: null;
}

async function ensurePullRequest(
	ctx: PublishContext,
	candidate: Candidate,
): Promise<{ number: number; id: number }> {
	if (ctx.identity.kind === "pr" && ctx.identity.prNumber && ctx.identity.prId) {
		return { number: ctx.identity.prNumber, id: ctx.identity.prId };
	}
	const existing = await findPullRequest(ctx);
	if (existing && existing.state === "open") return existing;
	const body = renderPullRequestBody({
		identity: ctx.identity,
		template: await ctx.pullRequestTemplate(),
		summary: candidate.summary,
		...(candidate.description ? { description: candidate.description } : {}),
		model: ctx.model,
		assignedBy: ctx.assignedBy,
	});
	const created = await ctx.github.raw<{ number?: number; id?: number }>(
		"POST",
		ctx.github.repoPath("/pulls"),
		{
			title: candidate.title,
			head: ctx.identity.branch,
			base: ctx.identity.defaultBranch,
			body,
			draft: false,
		},
	);
	if (created.status === 201 && created.data.number && created.data.id) {
		await ctx.fault("after-pr-created");
		return { number: created.data.number, id: created.data.id };
	}
	// A lost or rejected response: reconcile before deciding anything.
	const again = await findPullRequest(ctx);
	if (again && again.state === "open") return again;
	throw new GitHubError(created.status, "create pull request", JSON.stringify(created.data));
}

export async function publish(ctx: PublishContext, candidateId: string): Promise<PublishResult> {
	const candidate = ctx.store.candidate(candidateId);
	if (!candidate) throw new Error(`unknown candidate ${candidateId}`);
	const opId = `publish:${candidate.id}`;
	let publication = ctx.store.publication(opId);
	if (publication?.state === "pr-ensured")
		return {
			state: "published",
			commitSha: publication.commitSha!,
			prNumber: publication.prNumber!,
		};
	if (publication && ["needs-human", "failed", "superseded"].includes(publication.state)) {
		return {
			state: publication.state === "superseded" ? "superseded" : "needs-human",
			reason: publication.error ?? publication.state,
		};
	}
	const latest = ctx.store.latestCandidate();
	const obsoleteGeneration = candidate.ownershipGeneration !== ctx.generation;
	if (
		(obsoleteGeneration || latest?.id !== candidate.id) &&
		(!publication || publication.state === "intent")
	) {
		const reason = obsoleteGeneration
			? "ownership generation is obsolete"
			: `superseded by ${latest?.id}`;
		if (publication) save(ctx, publication, { state: "superseded", error: reason });
		ctx.store.log("publication.superseded", { candidate: candidate.id, reason });
		return { state: "superseded", reason };
	}

	if (obsoleteGeneration && publication) {
		// Cancellation arrived after an external effect may have applied:
		// reconcile and report it, and create nothing further.
		const head = await ctx.github.branchHead(publication.branch);
		const applied = publication.commitSha !== null && head === publication.commitSha;
		save(ctx, publication, {
			state: applied ? "ref-updated" : "superseded",
			error: "ownership generation is obsolete",
		});
		ctx.store.log("publication.cancelled", {
			candidate: candidate.id,
			appliedBeforeCancellation: applied,
			head,
		});
		return {
			state: "superseded",
			reason: applied
				? "branch update applied before cancellation; no pull request created"
				: "cancelled before any branch update",
		};
	}

	const patch = await readArtifact(ctx.artifacts, candidate.artifactKey, candidate.artifactDigest);

	if (!publication) {
		publication = {
			opId,
			candidateId: candidate.id,
			branch: ctx.identity.branch,
			expectedHead: candidate.expectedBranchHead,
			parentCommit: candidate.sourceBaseCommit,
			treeSha: candidate.sourceTreeHash,
			message: commitMessage(ctx.identity, candidate),
			authorDate: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
			state: "intent",
			commitSha: null,
			prNumber: null,
			prId: null,
			error: null,
			attempts: 0,
			updatedAt: Date.now(),
		};
		ctx.store.putPublication(publication);
		ctx.store.log("publication.intent", {
			op: opId,
			candidate: candidate.id,
			branch: publication.branch,
			expectedHead: publication.expectedHead,
		});
	}
	publication = save(ctx, publication, { attempts: publication.attempts + 1 });

	try {
		if (publication.state === "intent" || publication.state === "commit-created") {
			const head = await ctx.github.branchHead(publication.branch);
			const applied = publication.commitSha !== null && head === publication.commitSha;
			if (!applied && head !== publication.expectedHead) {
				if (publication.expectedHead === null && head !== null && ctx.identity.ownsBranch) {
					// The bot's branch exists from an earlier case attempt we have no record of.
					publication = save(ctx, publication, {
						state: "needs-human",
						error: `bot branch ${publication.branch} already exists at ${head.slice(0, 12)}`,
					});
					return { state: "needs-human", reason: publication.error! };
				}
				ctx.store.log("publication.branch-advanced", {
					expected: publication.expectedHead,
					observed: head,
				});
				const result = await integrate(ctx, candidate, patch, head!);
				save(ctx, publication, {
					state: result.state === "integrated" ? "superseded" : "needs-human",
					error:
						result.state === "integrated"
							? `branch advanced; integrated as ${result.candidate.id}`
							: (result as { reason: string }).reason,
				});
				return result;
			}
			if (!applied) {
				if (publication.state === "intent") {
					const tree = await buildTree(ctx, candidate, patch);
					const author = { ...ctx.config.commitAuthor, date: publication.authorDate };
					const commit = await ctx.github.request<{ sha: string }>(
						"POST",
						ctx.github.repoPath("/git/commits"),
						{
							message: publication.message,
							tree,
							parents: commitParents(publication),
							author,
							committer: author,
						},
					);
					publication = save(ctx, publication, { state: "commit-created", commitSha: commit.sha });
					ctx.store.log("publication.commit-created", { op: opId, commit: commit.sha });
					await ctx.fault("after-commit-created");
				}
				const sha = publication.commitSha!;
				const ref =
					publication.expectedHead === null
						? await ctx.github.raw("POST", ctx.github.repoPath("/git/refs"), {
								ref: `refs/heads/${publication.branch}`,
								sha,
							})
						: await ctx.github.raw(
								"PATCH",
								ctx.github.repoPath(`/git/refs/heads/${publication.branch}`),
								{ sha, force: false },
							);
				await ctx.fault("after-ref-update");
				if (ref.status >= 300) {
					const observed = await ctx.github.branchHead(publication.branch);
					if (observed !== sha) {
						ctx.store.log("publication.ref-rejected", { status: ref.status, observed });
						// Next attempt sees the advanced branch and integrates or hands off.
						throw new Error(`branch update rejected (${ref.status}); remote head is ${observed}`);
					}
				}
			} else {
				ctx.store.log("publication.reconciled", {
					op: opId,
					commit: publication.commitSha,
					note: "branch already at the intended commit",
				});
			}
			publication = save(ctx, publication, { state: "ref-updated" });
			ctx.store.log("publication.ref-updated", {
				op: opId,
				branch: publication.branch,
				commit: publication.commitSha,
			});
		}
		const pr = await ensurePullRequest(ctx, candidate);
		await ctx.registerAlias(`number:${pr.number}`);
		publication = save(ctx, publication, {
			state: "pr-ensured",
			prNumber: pr.number,
			prId: pr.id,
			error: null,
		});
		ctx.store.log("publication.receipt", {
			op: opId,
			commit: publication.commitSha,
			pr: pr.number,
		});
		return { state: "published", commitSha: publication.commitSha!, prNumber: pr.number };
	} catch (error) {
		if (error instanceof IntegrityError) {
			save(ctx, publication, { state: "needs-human", error: error.message });
			ctx.store.log("publication.integrity-failure", { op: opId, error: error.message });
			return { state: "needs-human", reason: error.message };
		}
		save(ctx, publication, { error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}
