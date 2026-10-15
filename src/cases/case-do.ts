// One case covers an issue and its pull request, or an adopted pull request,
// through implementation and revision. Pi Durable owns the author's turns and
// tools through PiHarness; this object owns admission, ownership generations,
// source checkpoints, candidates, publication and readiness.

import { DurableObject } from "cloudflare:workers";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import authorSkill from "../../skills/emdash-author/SKILL.md?raw";
import {
	type BotConfig,
	faultsEnabled,
	parseModelRef,
	readConfig,
	repositoryFor,
} from "../config.ts";
import { type ExecBackend, REPO_DIR, openBackend } from "../execution/backend.ts";
import { SandboxExecutionEnv } from "../execution/env.ts";
import { writeToken } from "../github/auth.ts";
import { classifyCheck, outcomeOf } from "../github/checks.ts";
import { GitHubClient } from "../github/client.ts";
import { type PublishContext, publish, readArtifact } from "../github/publisher.ts";
import { type ReviewComment, actionableCount, parseReview } from "../github/review.ts";
import {
	STATUS_CHECK_NAME,
	renderMovedToPullRequest,
	renderStatus,
	renderStatusCheck,
	statusMarker,
} from "../reports/render.ts";
import { type WorkPlan, updateWorkPlan } from "../reports/work-plan.ts";
import { type StatusReport, computeStatus } from "../reports/status.ts";
import { setupModels } from "../runtime/models.ts";
import {
	type TriageVerdict,
	decide,
	declineMessage,
	runClef,
	triageRequest,
} from "../runtime/triage.ts";
import { DEFAULT_PRIVILEGED_PREFIXES, PatchRejected, validatePatch } from "../source/patch.ts";
import {
	captureSource,
	git,
	materialize,
	prepareCheckout,
	readState,
	writeState,
} from "../source/workspace.ts";
import { type CaseRuntime, type MutationOutcome, caseExtension } from "../tools/case-tools.ts";
import { Mutex, errorMessage, sha256Hex, str, text } from "../util.ts";
import { CaseStore } from "./store.ts";
import { repositories } from "../bindings.ts";
import type {
	Candidate,
	CaseEvent,
	CaseIdentity,
	CheckpointRow,
	ReplyIntent,
	Verification,
} from "./types.ts";

export interface CaseDelivery {
	readonly deliveryId: string;
	readonly caseId: string;
	readonly kind: string;
	readonly actor: string;
	readonly provenance: string;
	readonly payload: Record<string, unknown>;
	readonly identity?: CaseIdentity;
}

interface DryRun {
	readonly baseCommit: string;
	readonly repository: {
		readonly focusedChecks?: Readonly<Record<string, string>>;
		readonly prepare?: string;
	};
}

interface Handoff {
	readonly reason: string;
	readonly nextAction: string;
	readonly at: number;
}

export class CaseDO extends DurableObject<Env> {
	readonly config: BotConfig;
	readonly store: CaseStore;
	readonly #source = new Mutex();
	#sandboxVerified = false;
	readonly registry = createRegistry();
	readonly harness: PiHarness;
	readonly lifecycle: Lifecycle<Env>;
	readonly #modelSetup;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.config = readConfig(env);
		this.store = new CaseStore(ctx.storage);
		this.#modelSetup = setupModels(env, this.config);
		this.registry.install(caseExtension(this.#runtime(), this.#modelSetup.beforeRequest));
		this.harness = new PiHarness({
			harness: ({ storage, context }) =>
				Harness.open(
					storage,
					{
						models: this.#modelSetup.models,
						registry: this.registry,
						settings: {
							retry: { enabled: true, ...this.config.modelRetry },
							toolExecution: "sequential",
						},
						env: () =>
							new SandboxExecutionEnv(this.#authorSandbox(), REPO_DIR, this.config.budgets.jobMs),
						onReport: (error) =>
							console.warn(JSON.stringify({ event: "pi.report", error: errorMessage(error) })),
					},
					context,
				),
			defaults: {
				model: this.#modelSetup.defaultModel,
				thinkingLevel: this.config.thinkingLevel ?? "medium",
			},
		});
		this.lifecycle = Lifecycle.install(this).use(this.harness);
	}

	// ---------------- Lifecycle host hooks ----------------

	async onStart(): Promise<void> {
		// Whatever the sandbox holds now may include unacknowledged writes.
		this.#sandboxVerified = false;
		if (this.store.state() === "active") await this.#schedule("reconcile", Date.now() + 1000);
	}

	async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
		try {
			return await this.#dispatchJob(context);
		} catch (error) {
			// Lifecycle retries the job; record why so failures are inspectable.
			this.store.log("job.failed", {
				fn: context.job.fn,
				attempt: context.attempt,
				error: errorMessage(error),
			});
			throw error;
		}
	}

	async #dispatchJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
		const payload = (context.job.payload ?? {}) as Record<string, unknown>;
		switch (context.job.fn) {
			case "reconcile":
				return this.#reconcile();
			case "publish":
				return this.#publishJob(String(payload.candidateId), Number(payload.attempt ?? 0));
			case "report":
				return this.#reportJob();
			case "replies":
				return this.#repliesJob();
		}
	}

	async #schedule(
		fn: "reconcile" | "report" | "publish" | "replies",
		time: number,
		payload: Record<string, unknown> = {},
		id?: string,
	): Promise<void> {
		await this.lifecycle.jobs.push({ id: id ?? fn, fn, time, payload });
	}

	// ---------------- fault injection (non-production) ----------------

	async #fault(boundary: string): Promise<void> {
		if (!faultsEnabled(this.config) || !this.store.takeFault(boundary)) return;
		this.store.log("fault.injected", { boundary });
		if (boundary === "report-failure") throw new Error("injected reporting failure");
		if (boundary === "after-candidate-sealed")
			await this.#authorSandbox()
				.destroy()
				.catch(() => undefined);
		// Make the disarm durable first; abort discards unflushed writes.
		await this.ctx.storage.sync();
		this.ctx.abort(`injected fault at ${boundary}`);
	}

	// ---------------- sandbox and source ----------------

	#identity(): CaseIdentity {
		const identity = this.store.identity();
		if (!identity) throw new Error("case has no identity");
		return identity;
	}

	#authorSandbox(): ExecBackend {
		const identity = this.#identity();
		return openBackend(this.env, this.ctx.exports, `author-${identity.caseId}`, {
			caseId: identity.caseId,
			repo: identity.repo,
		});
	}

	#remoteUrl(): string {
		return `${this.config.gitRemoteBase}/${this.#identity().repo}.git`;
	}

	#repoConfig() {
		const identity = this.#identity();
		const dryRun = this.#dryRun();
		if (dryRun) return { id: identity.repoId, fullName: identity.repo, ...dryRun.repository };
		return repositoryFor(this.config, identity.repoId, identity.repo);
	}

	/** A staging-only dry run: a pinned base, anonymous reads, and no GitHub writes. */
	#dryRun(): DryRun | undefined {
		return faultsEnabled(this.config)
			? (this.store.getMeta<DryRun>("dryRun") ?? undefined)
			: undefined;
	}

	async #ensureSandbox(): Promise<void> {
		const latest = this.store.latestCheckpoint() ?? (await this.#prepareCase());
		const backend = this.#authorSandbox();
		if (this.#sandboxVerified && (await readState(backend)) === latest.id) return;
		const started = Date.now();
		const prepared = await prepareCheckout(backend, {
			remoteUrl: this.#remoteUrl(),
			baseCommit: latest.baseCommit,
			timeoutMs: this.config.budgets.setupMs,
			prepareCommand: this.#repoConfig()?.prepare,
		});
		const patch =
			latest.size > 0
				? await readArtifact(this.env.ARTIFACTS, latest.artifactKey, latest.digest)
				: null;
		const tree = await materialize(backend, latest.baseCommit, patch);
		if (tree !== latest.treeHash)
			throw new Error(
				`restored tree ${tree} does not match checkpoint ${latest.id} (${latest.treeHash})`,
			);
		await writeState(backend, latest.id);
		this.#sandboxVerified = true;
		this.store.log("sandbox.restored", {
			checkpoint: latest.id,
			fresh: prepared.fresh,
			fetchMs: prepared.fetchMs,
			prepareMs: prepared.prepareMs,
			totalMs: Date.now() - started,
		});
	}

	/**
	 * Establish where work starts: the pinned dry-run commit, the adopted pull
	 * request's head, or the default branch. Loads the repository instructions
	 * from the default branch at that commit. Idempotent.
	 */
	async #prepareCase(): Promise<CheckpointRow> {
		const existing = this.store.latestCheckpoint();
		if (existing && this.store.getMeta("instructions")) return existing;
		const identity = this.#identity();
		const dryRun = this.#dryRun();
		const github = this.#github();
		const defaultHead = dryRun?.baseCommit ?? (await github.branchHead(identity.defaultBranch));
		if (!defaultHead) throw new Error(`default branch ${identity.defaultBranch} not found`);
		if (!this.store.getMeta("instructions")) {
			const agents =
				(dryRun
					? await this.#sandboxFile("AGENTS.md", defaultHead)
					: await this.#fileAt("AGENTS.md", defaultHead)) ?? "";
			this.store.setMeta("instructions", { commit: defaultHead, text: agents.slice(0, 40_000) });
			if (!dryRun)
				this.store.setMeta(
					"prTemplate",
					await this.#fileAt(".github/PULL_REQUEST_TEMPLATE.md", defaultHead),
				);
		}
		if (existing) return existing;
		const base =
			dryRun?.baseCommit ??
			(identity.kind === "pr" ? await github.branchHead(identity.branch) : null) ??
			defaultHead;
		const tree = dryRun ? await this.#sandboxTree(base) : await github.commitTree(base);
		return this.#baseCheckpoint(base, tree);
	}

	/** Capture the sandbox source as an acknowledged checkpoint (inside the source mutex). */
	async #capture(
		opId: string,
	): Promise<{ checkpoint: CheckpointRow; changed: boolean; timing: Record<string, number> }> {
		const latest = this.store.latestCheckpoint()!;
		const backend = this.#authorSandbox();
		const t0 = Date.now();
		const captured = await captureSource(backend, latest.baseCommit);
		const t1 = Date.now();
		const digest = await sha256Hex(captured.patch);
		if (digest === latest.digest)
			return { checkpoint: latest, changed: false, timing: { diffMs: t1 - t0 } };
		try {
			validatePatch(captured.patch, {
				maxBytes: this.config.maxArtifactBytes,
				privilegedPrefixes: DEFAULT_PRIVILEGED_PREFIXES,
			});
		} catch (error) {
			if (error instanceof PatchRejected) {
				this.#sandboxVerified = false;
				await this.#ensureSandbox();
				this.store.log("checkpoint.rejected", { op: opId, reason: error.message });
			}
			throw error;
		}
		const identity = this.#identity();
		const key = `cases/${identity.caseId}/checkpoints/${digest}.patch`;
		await this.env.ARTIFACTS.put(key, captured.patch, {
			sha256: digest,
			customMetadata: { case: identity.caseId, base: latest.baseCommit, tree: captured.treeHash },
		});
		const t2 = Date.now();
		await this.#fault("after-checkpoint-upload");
		const checkpoint = this.store.transaction(() =>
			this.store.insertCheckpoint({
				id: `cp-${digest.slice(0, 16)}-${Date.now().toString(36)}`,
				opId,
				baseCommit: latest.baseCommit,
				treeHash: captured.treeHash,
				digest,
				artifactKey: key,
				size: captured.patch.byteLength,
				generation: this.store.generation(),
				createdAt: Date.now(),
			}),
		);
		const t3 = Date.now();
		await writeState(backend, checkpoint.id);
		this.store.log("checkpoint.commit", {
			op: opId,
			checkpoint: checkpoint.id,
			tree: checkpoint.treeHash,
			size: checkpoint.size,
			diffMs: t1 - t0,
			uploadMs: t2 - t1,
			commitMs: t3 - t2,
		});
		return {
			checkpoint,
			changed: true,
			timing: { diffMs: t1 - t0, uploadMs: t2 - t1, commitMs: t3 - t2 },
		};
	}

	async #baseCheckpoint(baseCommit: string, treeHash: string): Promise<CheckpointRow> {
		const latest = this.store.latestCheckpoint();
		if (latest?.baseCommit === baseCommit) return latest;
		const identity = this.#identity();
		const empty = new Uint8Array();
		const digest = await sha256Hex(empty);
		const key = `cases/${identity.caseId}/checkpoints/${digest}.patch`;
		await this.env.ARTIFACTS.put(key, empty, { sha256: digest });
		const checkpoint = this.store.insertCheckpoint({
			id: `cp-base-${baseCommit.slice(0, 12)}-${Date.now().toString(36)}`,
			opId: `base:${baseCommit}`,
			baseCommit,
			treeHash,
			digest,
			artifactKey: key,
			size: 0,
			generation: this.store.generation(),
			createdAt: Date.now(),
		});
		this.#sandboxVerified = false;
		this.store.log("checkpoint.base", { checkpoint: checkpoint.id, base: baseCommit });
		return checkpoint;
	}

	// ---------------- tool runtime ----------------

	#runtime(): CaseRuntime {
		return {
			guard: (terminal) => this.#guard(terminal),
			ready: () => this.#source.run(() => this.#ensureSandbox()),
			mutate: <T>(opId: string, tool: string, fn: () => Promise<T>) => this.#mutate(opId, tool, fn),
			search: (pattern, path, glob) => this.#search(pattern, path, glob),
			listFiles: (path) => this.#listFiles(path),
			runCheck: (opId, name, args) => this.#runCheck(opId, name, args),
			submitCandidate: (opId, title, summary) => this.#submitCandidate(opId, title, summary),
			handoff: (opId, reason, nextAction) => this.#handoff(opId, reason, nextAction),
			reply: async (opId, inReplyTo, onIssue, body) => {
				const intent = this.#queueReply(opId, inReplyTo, onIssue, body);
				await this.#schedule("replies", Date.now(), {}, "replies");
				return intent.key;
			},
			caseRecord: () => (this.store.identity() ? this.#caseRecord() : ""),
			recordReporterConfirmation: (commentId) => this.#recordReporterConfirmation(commentId),
			decline: (opId, reason, message) => this.#decline(opId, reason, message),
			updateWorkPlan: async (input) => {
				const plan = updateWorkPlan(
					this.store.getMeta<WorkPlan>("workPlan") ?? null,
					input,
					Date.now(),
				);
				this.store.setMeta("workPlan", plan);
				this.store.log("plan.updated", { steps: plan.steps.length });
				await this.#schedule("report", Date.now());
				return "Plan updated; it appears in the progress comment.";
			},
			focusedChecks: () => this.#repoConfig()?.focusedChecks ?? {},
			recordUsage: (tokens, cacheRead) => {
				this.store.setMeta("tokens", (this.store.getMeta<number>("tokens") ?? 0) + tokens);
				this.store.setMeta(
					"cacheReadTokens",
					(this.store.getMeta<number>("cacheReadTokens") ?? 0) + cacheRead,
				);
			},
			instructions: () => {
				const loaded = this.store.getMeta<{ commit: string; text: string }>("instructions");
				return [
					loaded
						? `Instructions from the default branch at ${loaded.commit}:\n\n${loaded.text}`
						: "",
					authorSkill,
				]
					.filter(Boolean)
					.join("\n\n---\n\n");
			},
		};
	}

	#guard(terminal = false): string | undefined {
		const state = this.store.state();
		if (state !== "active") return `the case is ${state ?? "not admitted"}; tool use is refused`;
		if (this.store.getMeta<number>("runGeneration") !== this.store.generation()) {
			return "this run belongs to an obsolete ownership generation";
		}
		if (terminal) return undefined;
		const budgets = this.config.budgets;
		const runStartedAt = this.store.getMeta<number>("runStartedAt");
		if (runStartedAt && Date.now() - runStartedAt > budgets.authorMs)
			return "the author time budget for this run is exhausted";
		const assignedAt =
			this.store.getMeta<number>("assignedAt") ??
			this.store.getMeta<number>("createdAt") ??
			Date.now();
		if (Date.now() - assignedAt > budgets.caseMs) return "the case time budget is exhausted";
		if ((this.store.getMeta<number>("tokens") ?? 0) > budgets.tokens)
			return "the token budget is exhausted";
		return undefined;
	}

	async #mutate<T>(opId: string, tool: string, fn: () => Promise<T>): Promise<MutationOutcome<T>> {
		return this.#source.run(async () => {
			const receipt = this.store.operation(opId);
			if (receipt?.status === "completed") {
				const result = receipt.result as { checkpointId: string };
				return { replayed: true, changed: false, checkpointId: result.checkpointId };
			}
			await this.#ensureSandbox();
			this.store.putOperation(opId, `tool:${tool}`, this.store.generation(), "started", null);
			await this.#fault("during-tool");
			let value: T | undefined;
			let error: unknown;
			try {
				value = await fn();
			} catch (e) {
				error = e;
			}
			const captured = await this.#capture(opId);
			this.store.putOperation(opId, `tool:${tool}`, this.store.generation(), "completed", {
				checkpointId: captured.checkpoint.id,
				changed: captured.changed,
				...(error ? { error: errorMessage(error) } : {}),
			});
			await this.#fault("after-checkpoint-commit");
			return {
				value,
				error,
				changed: captured.changed,
				checkpointId: captured.checkpoint.id,
				replayed: false,
			};
		});
	}

	async #search(
		pattern: string,
		path: string | undefined,
		glob: string | undefined,
	): Promise<string> {
		const argv = [
			"rg",
			"-n",
			"--no-heading",
			"--color=never",
			"-m",
			"50",
			...(glob ? ["-g", glob] : []),
			"-e",
			pattern,
			"--",
			path ?? ".",
		];
		const result = await this.#authorSandbox().exec({ argv, cwd: REPO_DIR, timeoutMs: 60_000 });
		if (result.exitCode === 1) return "No matches.";
		const out = text(result.stdout) || text(result.stderr);
		return out.length > 30_000 ? `${out.slice(0, 30_000)}\n[truncated]` : out;
	}

	async #listFiles(path: string | undefined): Promise<string> {
		const result = await this.#authorSandbox().exec({
			argv: [
				"git",
				"-c",
				"safe.directory=*",
				"ls-files",
				"-co",
				"--exclude-standard",
				"--",
				path ?? ".",
			],
			cwd: REPO_DIR,
			timeoutMs: 60_000,
		});
		const out = text(result.stdout);
		const lines = out.split("\n");
		return lines.length > 2000
			? `${lines.slice(0, 2000).join("\n")}\n[${lines.length - 2000} more]`
			: out || "No files.";
	}

	async #runCheck(opId: string, name: string, args: string | undefined): Promise<Verification> {
		const command = this.#repoConfig()?.focusedChecks?.[name];
		if (!command)
			throw new Error(
				`unknown check ${name}; configured checks: ${Object.keys(this.#repoConfig()?.focusedChecks ?? {}).join(", ") || "none"}`,
			);
		return this.#source.run(async () => {
			await this.#ensureSandbox();
			const before = (await this.#capture(`${opId}:before`)).checkpoint;
			const full = args ? `${command} ${args}` : command;
			const id = `check:${before.treeHash}:${(await sha256Hex(full)).slice(0, 16)}`;
			const existing = this.store.verification(id);
			if (existing && existing.outcome !== "running") return existing;
			const attemptId = existing ? `${id}:retry-${Date.now().toString(36)}` : id;
			if (existing)
				this.store.putVerification({
					...existing,
					outcome: "interrupted",
					completedAt: Date.now(),
				});
			const candidate = this.store.latestCandidate();
			const base: Verification = {
				id: attemptId,
				candidateId: candidate?.sourceTreeHash === before.treeHash ? candidate.id : null,
				treeHash: before.treeHash,
				commitSha: null,
				name,
				kind: "sandbox",
				environment: `sandbox:${this.#identity().caseId}`,
				outcome: "running",
				classification: null,
				startedAt: Date.now(),
				completedAt: null,
				details: { command: full },
			};
			this.store.putVerification(base);
			const result = await this.#authorSandbox().exec({
				argv: ["bash", "-c", full],
				cwd: REPO_DIR,
				timeoutMs: this.config.budgets.jobMs,
			});
			const output = `${text(result.stdout)}\n${text(result.stderr)}`.trim();
			const after = (await this.#capture(`${opId}:after`)).checkpoint;
			const done: Verification = {
				...base,
				outcome: result.timedOut ? "failed" : result.exitCode === 0 ? "succeeded" : "failed",
				classification:
					result.exitCode === 0 ? "success" : result.timedOut ? "infrastructure" : "code",
				completedAt: Date.now(),
				details: {
					command: full,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					durationMs: Date.now() - base.startedAt,
					output: output.length > 8000 ? `[...]\n${output.slice(-8000)}` : output,
					...(after.id !== before.id ? { sourceChangedDuringRun: after.id } : {}),
				},
			};
			this.store.putVerification(done);
			this.store.log("verification.recorded", {
				id: attemptId,
				name,
				outcome: done.outcome,
				tree: before.treeHash,
			});
			return done;
		});
	}

	async #submitCandidate(opId: string, title: string, summary: string): Promise<Candidate> {
		const receipt = this.store.operation(opId);
		if (receipt?.status === "completed")
			return this.store.candidate((receipt.result as { candidateId: string }).candidateId)!;
		const candidate = await this.#source.run(async () => {
			await this.#ensureSandbox();
			const { checkpoint } = await this.#capture(`${opId}:seal`);
			if (checkpoint.size === 0)
				throw new Error(
					"there are no source changes to submit; use handoff if no change is correct",
				);
			// Seal: the artifact must be complete and match its digest.
			await readArtifact(this.env.ARTIFACTS, checkpoint.artifactKey, checkpoint.digest);
			const published = this.store
				.publications()
				.some((p) => p.state === "ref-updated" || p.state === "pr-ensured");
			const identity = this.#identity();
			const previous = this.store.latestCandidate();
			const sealed: Candidate = {
				id: `cand-${this.store.candidates().length + 1}-${checkpoint.digest.slice(0, 10)}`,
				caseId: identity.caseId,
				ownershipGeneration: this.store.generation(),
				parentCandidateId: previous?.id ?? null,
				sourceBaseCommit: checkpoint.baseCommit,
				expectedBranchHead: identity.kind === "pr" || published ? checkpoint.baseCommit : null,
				sourceTreeHash: checkpoint.treeHash,
				artifactDigest: checkpoint.digest,
				artifactKey: checkpoint.artifactKey,
				requirementsRevision: this.store.requirementsRevision(),
				checkpointId: checkpoint.id,
				title: title.slice(0, 200),
				summary: summary.slice(0, 20_000),
				origin: "author",
				createdAt: Date.now(),
			};
			this.store.transaction(() => {
				this.store.putCandidate(sealed);
				this.store.putOperation(opId, "submit_candidate", sealed.ownershipGeneration, "completed", {
					candidateId: sealed.id,
				});
			});
			this.store.log("candidate.sealed", {
				candidate: sealed.id,
				tree: sealed.sourceTreeHash,
				base: sealed.sourceBaseCommit,
				expectedHead: sealed.expectedBranchHead,
			});
			return sealed;
		});
		await this.#schedule(
			"publish",
			Date.now(),
			{ candidateId: candidate.id },
			`publish:${candidate.id}`,
		);
		await this.#schedule("reconcile", Date.now() + 2000);
		await this.#fault("after-candidate-sealed");
		return candidate;
	}

	async #sealIntegration(
		parent: Candidate,
		base: string,
		patch: Uint8Array,
		treeHash: string,
	): Promise<Candidate> {
		const digest = await sha256Hex(patch);
		validatePatch(patch, {
			maxBytes: this.config.maxArtifactBytes,
			privilegedPrefixes: DEFAULT_PRIVILEGED_PREFIXES,
		});
		const identity = this.#identity();
		const key = `cases/${identity.caseId}/checkpoints/${digest}.patch`;
		await this.env.ARTIFACTS.put(key, patch, { sha256: digest });
		const checkpoint = this.store.insertCheckpoint({
			id: `cp-int-${digest.slice(0, 12)}-${Date.now().toString(36)}`,
			opId: `integrate:${parent.id}`,
			baseCommit: base,
			treeHash,
			digest,
			artifactKey: key,
			size: patch.byteLength,
			generation: this.store.generation(),
			createdAt: Date.now(),
		});
		this.#sandboxVerified = false;
		const candidate: Candidate = {
			...parent,
			id: `cand-${this.store.candidates().length + 1}-${digest.slice(0, 10)}`,
			parentCandidateId: parent.id,
			sourceBaseCommit: base,
			expectedBranchHead: base,
			sourceTreeHash: treeHash,
			artifactDigest: digest,
			artifactKey: key,
			checkpointId: checkpoint.id,
			origin: "integration",
			createdAt: Date.now(),
		};
		this.store.putCandidate(candidate);
		this.store.log("candidate.integrated", {
			candidate: candidate.id,
			parent: parent.id,
			base,
			note: "prior verification is not reused",
		});
		await this.#schedule(
			"publish",
			Date.now(),
			{ candidateId: candidate.id },
			`publish:${candidate.id}`,
		);
		return candidate;
	}

	async #handoff(opId: string, reason: string, nextAction: string): Promise<void> {
		const handoff: Handoff = { reason, nextAction, at: Date.now() };
		this.store.transaction(() => {
			this.store.setMeta("handoff", handoff);
			this.store.putOperation(opId, "handoff", this.store.generation(), "completed", handoff);
		});
		this.store.log("handoff", { reason, nextAction });
		await this.#schedule("report", Date.now());
	}

	// ---------------- conversation ----------------

	/** Record a reply for trusted code to post once. */
	#queueReply(
		opId: string,
		inReplyTo: number | undefined,
		onIssue: boolean,
		body: string,
	): ReplyIntent {
		const intents = this.store.getMeta<ReplyIntent[]>("replyIntents") ?? [];
		const existing = intents.find((i) => i.key === opId);
		if (existing) return existing;
		const intent: ReplyIntent = {
			key: opId,
			inReplyTo: inReplyTo ?? null,
			target: onIssue ? "issue" : "pr",
			body: body.slice(0, 20_000),
			generation: this.store.generation(),
			status: "pending",
			postedCommentId: null,
			createdAt: Date.now(),
		};
		this.store.setMeta("replyIntents", [...intents, intent]);
		this.store.log("reply.intent", { key: opId, inReplyTo: intent.inReplyTo });
		return intent;
	}

	#recordReporterConfirmation(commentId: number): string {
		const event = this.store
			.events()
			.find((e) => e.kind === "comment" && Number(e.payload.commentId) === commentId);
		if (!event) throw new Error(`comment ${commentId} is not a recorded comment on this case`);
		if (event.provenance !== "reporter" && event.actor !== this.store.getMeta<string>("reporter")) {
			throw new Error(`comment ${commentId} is from ${event.actor}, not the reporter`);
		}
		this.store.setMeta("reporterConfirmation", { commentId, actor: event.actor, at: Date.now() });
		this.store.log("reporter.confirmed", { comment: commentId, by: event.actor });
		return `Recorded the reporter's confirmation (comment ${commentId}).`;
	}

	/** The author declines the issue: optionally say why on it, then stop working the case. */
	async #decline(opId: string, reason: string, message: string | undefined): Promise<void> {
		if (message?.trim()) this.#queueReply(`${opId}:message`, undefined, true, message);
		const handoff: Handoff = {
			reason: `declined: ${reason}`,
			nextAction: "a maintainer can apply the intake label to assign it anyway",
			at: Date.now(),
		};
		this.store.transaction(() => {
			this.store.setMeta("state", "declined");
			this.store.setMeta("handoff", handoff);
			this.store.putOperation(opId, "decline", this.store.generation(), "completed", { reason });
		});
		this.store.log("case.declined", { reason, publicMessage: !!message?.trim() });
		await this.#schedule("replies", Date.now(), {}, "replies");
		await this.#schedule("report", Date.now());
	}

	/** Ask Clef whether an unassigned issue is in scope. Fails closed. */
	async #triage(payload: Record<string, unknown>): Promise<TriageVerdict> {
		const identity = this.#identity();
		const request = triageRequest({
			repo: identity.repo,
			title: str(payload.title ?? ""),
			body: str(payload.body ?? ""),
			opener: str(payload.reporter ?? ""),
			openerIsMaintainer: payload.openerIsMaintainer === true,
			rules: this.store.getMeta<{ text: string }>("instructions")?.text ?? "",
		});
		try {
			const fake = (this.env as { TRIAGE_FAKE?: Fetcher }).TRIAGE_FAKE;
			const answers = fake
				? await (
						await fake.fetch("https://triage/classify", {
							method: "POST",
							body: JSON.stringify(request),
						})
					).json<Record<string, never>>()
				: await runClef(this.env.AI, request, this.config.gatewayId);
			return decide(answers, this.config.triage, "@cf/cloudflare/clef");
		} catch (error) {
			return decide(
				{},
				this.config.triage,
				`@cf/cloudflare/clef (unavailable: ${errorMessage(error)})`,
			);
		}
	}

	async #repliesJob(): Promise<LifecycleJobOutcome | void> {
		const intents = this.store.getMeta<ReplyIntent[]>("replyIntents") ?? [];
		const pending = intents.filter((i) => i.status === "pending");
		if (pending.length === 0) return;
		const identity = this.#identity();
		const prNumber = this.store.getMeta<number>("pr") ?? identity.prNumber;
		if (this.#dryRun()) return;
		const github = this.#github();
		for (const intent of pending) {
			if (intent.generation !== this.store.generation()) {
				this.#saveIntent({ ...intent, status: "dropped" });
				this.store.log("reply.dropped", { key: intent.key, reason: "obsolete generation" });
				continue;
			}
			const target =
				intent.inReplyTo || intent.target === "pr"
					? (prNumber ?? identity.issueNumber)
					: (identity.issueNumber ?? prNumber);
			if (!target) {
				this.#saveIntent({ ...intent, status: "dropped" });
				this.store.log("reply.dropped", {
					key: intent.key,
					reason: "no issue or pull request to post on",
				});
				continue;
			}
			const marker = `<!-- emdash-bot:reply key=${intent.key} -->`;
			const body = `${intent.body.trim()}\n\n${marker}`;
			let postedId: number | undefined;
			if (intent.inReplyTo) {
				const path = github.repoPath(`/pulls/${target}/comments?per_page=100`);
				const find = async () =>
					(await github.request<Array<{ id: number; body: string }>>("GET", path)).find((c) =>
						c.body.includes(marker),
					)?.id;
				postedId = await find();
				if (!postedId) {
					const created = await github.raw<{ id?: number }>(
						"POST",
						github.repoPath(`/pulls/${target}/comments/${intent.inReplyTo}/replies`),
						{ body },
					);
					postedId = created.status === 201 && created.data.id ? created.data.id : await find();
				}
			} else {
				const path = github.repoPath(`/issues/${target}/comments?per_page=100`);
				const find = async () =>
					(await github.request<Array<{ id: number; body: string }>>("GET", path)).find((c) =>
						c.body.includes(marker),
					)?.id;
				postedId = await find();
				if (!postedId) {
					const created = await github.raw<{ id?: number }>(
						"POST",
						path.replace("?per_page=100", ""),
						{ body },
					);
					postedId = created.status === 201 && created.data.id ? created.data.id : await find();
				}
			}
			if (!postedId) throw new Error(`reply ${intent.key} could not be posted or found`);
			this.#saveIntent({ ...intent, status: "posted", postedCommentId: postedId });
			this.store.log("reply.posted", {
				key: intent.key,
				comment: postedId,
				inReplyTo: intent.inReplyTo,
			});
		}
	}

	#saveIntent(intent: ReplyIntent): void {
		const intents = this.store.getMeta<ReplyIntent[]>("replyIntents") ?? [];
		this.store.setMeta(
			"replyIntents",
			intents.map((i) => (i.key === intent.key ? intent : i)),
		);
	}

	// ---------------- GitHub ----------------

	#github(): GitHubClient {
		return new GitHubClient(
			this.config.githubApiUrl,
			() => (this.#dryRun() ? Promise.resolve("") : writeToken(this.env, this.config)),
			this.#identity().repo,
		);
	}

	async #fileAt(path: string, ref: string): Promise<string | null> {
		const github = this.#github();
		const response = await github.raw<{ content?: string; encoding?: string }>(
			"GET",
			github.repoPath(`/contents/${path}?ref=${encodeURIComponent(ref)}`),
		);
		if (response.status !== 200 || !response.data?.content) return null;
		const binary = atob(response.data.content.replace(/\n/g, ""));
		return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
	}

	/** Read a file at a commit from the sandbox checkout (no REST API call). */
	async #sandboxFile(path: string, commit: string): Promise<string | null> {
		const backend = this.#authorSandbox();
		await prepareCheckout(backend, {
			remoteUrl: this.#remoteUrl(),
			baseCommit: commit,
			timeoutMs: this.config.budgets.setupMs,
		});
		const result = await backend.exec({ argv: git("show", `${commit}:${path}`) });
		return result.exitCode === 0 ? text(result.stdout) : null;
	}

	async #sandboxTree(commit: string): Promise<string> {
		const backend = this.#authorSandbox();
		await prepareCheckout(backend, {
			remoteUrl: this.#remoteUrl(),
			baseCommit: commit,
			timeoutMs: this.config.budgets.setupMs,
		});
		const result = await backend.exec({ argv: git("rev-parse", `${commit}^{tree}`) });
		if (result.exitCode !== 0) throw new Error(`cannot resolve the tree of ${commit}`);
		return text(result.stdout).trim();
	}

	async #authorSlot(
		action: "acquire" | "release",
	): Promise<{ granted: boolean; holders: string[] }> {
		const identity = this.#identity();
		const router = repositories(this.env).getByName(String(identity.repoId));
		if (action === "release") {
			await router.releaseAuthorSlot(identity.caseId);
			return { granted: true, holders: [] };
		}
		return router.acquireAuthorSlot(
			identity.caseId,
			this.config.maxActiveAuthors,
			this.config.budgets.authorMs + this.config.budgets.setupMs,
		);
	}

	/** The inline comments of one review on the case's pull request. */
	async #reviewComments(reviewId: number): Promise<ReviewComment[]> {
		const pr = this.store.getMeta<number>("pr") ?? this.#identity().prNumber;
		if (!pr) return [];
		const github = this.#github();
		const comments = await github.request<
			Array<{
				id: number;
				path?: string;
				line?: number | null;
				original_line?: number | null;
				body?: string;
			}>
		>("GET", github.repoPath(`/pulls/${pr}/reviews/${reviewId}/comments?per_page=100`));
		return comments.map((c) => ({
			id: c.id,
			path: c.path ?? null,
			line: c.line ?? c.original_line ?? null,
			body: c.body ?? "",
		}));
	}

	async #registerAlias(alias: string): Promise<void> {
		const identity = this.#identity();
		await repositories(this.env)
			.getByName(String(identity.repoId))
			.registerAlias(alias, identity.caseId);
	}

	// ---------------- admission ----------------

	async deliver(
		delivery: CaseDelivery,
	): Promise<{ accepted: boolean; duplicate: boolean; caseId: string }> {
		await this.lifecycle.start();
		const existing = this.store.identity();
		if (!existing) {
			if (delivery.kind !== "assigned" || !delivery.identity) {
				this.store.log("admission.rejected", {
					delivery: delivery.deliveryId,
					reason: "case does not exist",
				});
				return { accepted: false, duplicate: false, caseId: delivery.caseId };
			}
		}
		const inserted = this.store.insertEvent({
			deliveryId: delivery.deliveryId,
			kind: delivery.kind,
			actor: delivery.actor,
			provenance: delivery.provenance,
			payload: delivery.payload,
			receivedAt: Date.now(),
		});
		if (!inserted) {
			this.store.log("admission.duplicate", { delivery: delivery.deliveryId });
			return { accepted: true, duplicate: true, caseId: delivery.caseId };
		}
		this.store.log("admission", {
			delivery: delivery.deliveryId,
			kind: delivery.kind,
			actor: delivery.actor,
			provenance: delivery.provenance,
		});
		const event = this.store.events().at(-1)!;
		const message = await this.#apply(event, delivery);
		if (message && this.store.state() === "active")
			await this.#submitToAuthor(event.deliveryId, message);
		// An adopted pull request may already carry reviews: read them now.
		if (
			event.kind === "assigned" &&
			this.store.identity()?.kind === "pr" &&
			this.store.state() === "active"
		) {
			await this.#syncReviews().catch((error: unknown) =>
				this.store.log("reviews.sync-failed", { error: errorMessage(error) }),
			);
		}
		if (this.store.state() === "active") await this.#schedule("reconcile", Date.now() + 500);
		return { accepted: true, duplicate: false, caseId: delivery.caseId };
	}

	/**
	 * Record an admitted event and return the message the author should
	 * receive, if any. Authority and provenance are decided here; what the
	 * message means is left to the author's judgement.
	 */
	async #apply(event: CaseEvent, delivery: CaseDelivery): Promise<string | null> {
		const payload = event.payload;
		const from = `${event.actor} (${event.provenance})`;
		switch (event.kind) {
			case "assigned": {
				const auto = payload.autoIntake === true;
				if (this.store.state() === "active") {
					// A maintainer explicitly taking on an automatically admitted issue.
					if (!auto && this.store.getMeta<boolean>("autoIntake")) {
						this.store.setMeta("autoIntake", false);
						this.store.setMeta("assignedBy", event.actor);
						this.store.log("ownership.confirmed-by-maintainer", { by: event.actor });
						return `## Assigned by a maintainer\nFrom: ${from}\n\nA maintainer has explicitly assigned this issue to you. Work on it unless you cannot do so correctly.`;
					}
					return null;
				}
				this.store.transaction(() => {
					if (!this.store.identity()) {
						this.store.setMeta("identity", delivery.identity);
						this.store.setMeta("createdAt", Date.now());
						this.store.addRequirement({
							source: str(payload.url ?? ""),
							actor: event.actor,
							body: `# ${str(payload.title ?? "")}\n\n${str(payload.body ?? "")}`,
							createdAt: Date.now(),
						});
						if (payload.reporter) this.store.setMeta("reporter", str(payload.reporter));
					}
					this.store.setMeta("generation", this.store.generation() + 1);
					this.store.setMeta("state", "active");
					// Auto-intake has no assigner: the opener is the reporter, not a maintainer.
					this.store.setMeta("assignedBy", auto ? null : event.actor);
					this.store.setMeta("autoIntake", auto);
					// The case time budget runs per ownership generation.
					this.store.setMeta("assignedAt", Date.now());
					this.store.setMeta("handoff", null);
				});
				this.store.log("ownership.assigned", {
					generation: this.store.generation(),
					by: auto ? null : event.actor,
					...(auto ? { autoIntake: true, opener: event.actor } : {}),
				});
				await this.#prepareCase().catch((error: unknown) =>
					this.store.log("case.prepare-failed", { error: errorMessage(error) }),
				);
				const identity = this.#identity();
				const what =
					identity.kind === "issue"
						? `issue #${identity.issueNumber}`
						: `pull request #${identity.prNumber}`;
				if (auto) {
					const verdict = await this.#triage(payload);
					this.store.setMeta("triage", verdict);
					this.store.log("triage", {
						decision: verdict.decision,
						kind: verdict.kind,
						reason: verdict.reason,
						actionable: verdict.actionable,
						size: verdict.size,
					});
					if (verdict.decision === "decline" || verdict.decision === "decline-silently") {
						await this.#decline(
							`triage:${event.deliveryId}`,
							`${verdict.kind}: ${verdict.reason}`,
							verdict.decision === "decline" ? declineMessage(verdict) : undefined,
						);
						return null;
					}
					if (verdict.decision === "needs-info") {
						return `## New issue (needs information)\nFrom: ${from}\n\n${event.actor} opened ${what}; its text is in the case record. No maintainer has assigned it. Independent triage judged it in scope but not actionable as written (${verdict.reason}). Reply on the issue asking the reporter for exactly what you need. Do not implement anything until they answer.`;
					}
					return `## New issue\nFrom: ${from}\n\n${event.actor} opened ${what}; its text is in the case record. No maintainer has assigned it. Independent triage judged it in scope: ${verdict.reason}. Work on it. If on closer inspection it is not a real bug or small, clear task with a bounded fix you can verify, call decline instead.`;
				}
				return `## Assigned\nFrom: ${from}\n\nYou have been assigned ${what}. Its text is in the case record. ${identity.kind === "issue" ? "Implement it and submit a candidate." : "Take over this pull request: bring it to a correct, reviewable state and submit a candidate."}`;
			}
			case "operator-round":
				return `## Operator note\nFrom: ${from}\n\n${str(payload.note ?? "")}`;
			case "unassigned":
				await this.#cancel(`unassigned by ${event.actor}`);
				return null;
			case "direction":
			case "comment":
				return `## Comment ${str(payload.commentId ?? "")} on ${payload.isPullRequest ? "the pull request" : "the issue"}\nFrom: ${from}${payload.url ? `\nLink: ${str(payload.url)}` : ""}\n\n${str(payload.body ?? "")}`;
			case "review":
			case "maintainer-review":
				return this.#applyReview(event);
			case "check":
				return this.#applyCheck(event);
			case "head-changed":
				this.store.setMeta("observedHead", str(payload.after));
				this.store.log("branch.advanced", { by: event.actor, head: payload.after });
				return `## Branch updated\nFrom: ${from}\n\n${event.actor} pushed ${str(payload.after).slice(0, 12)} to the case branch. Your next candidate is published on top of it.`;
			case "pr-opened":
				return null;
			case "closed": {
				const isIssue = payload.issue === true;
				if (isIssue && this.store.publications().some((p) => p.state === "pr-ensured")) return null;
				this.store.setMeta("state", "terminal");
				this.store.setMeta("generation", this.store.generation() + 1);
				this.store.log("case.terminal", { merged: payload.merged === true, issue: isIssue });
				await this.#stopAuthor();
				await this.#schedule("report", Date.now());
				return null;
			}
			default:
				return null;
		}
	}

	#currentHead(): string | null {
		const observed = this.store.getMeta<string>("observedHead");
		if (observed) return observed;
		return (
			this.store
				.publications()
				.filter((p) => p.commitSha && (p.state === "ref-updated" || p.state === "pr-ensured"))
				.at(-1)?.commitSha ?? null
		);
	}

	/**
	 * Record a review as readiness evidence and describe it for the author:
	 * its state, body, findings block and inline comments with their IDs, so
	 * the author can reply in the right thread.
	 */
	async #applyReview(event: CaseEvent): Promise<string | null> {
		const payload = event.payload as {
			reviewId: number;
			body: string;
			commitId: string;
			state: string;
			url?: string;
		};
		const comments = await this.#reviewComments(payload.reviewId).catch((error: unknown) => {
			this.store.log("review.comments-unavailable", {
				review: payload.reviewId,
				error: errorMessage(error),
			});
			return [] as ReviewComment[];
		});
		const parsed = parseReview(
			payload.body,
			payload.reviewId,
			payload.commitId,
			payload.state,
			comments,
		);
		const configured = event.kind === "review";
		if (configured) {
			const fresh = this.store.putReview({
				reviewId: String(payload.reviewId),
				reviewer: event.actor,
				commit: parsed.reviewedCommit,
				state: payload.state,
				structured: parsed.structured,
				actionable: actionableCount(parsed),
				receivedAt: Date.now(),
			});
			if (!fresh) return null;
		}
		this.store.log("review.recorded", {
			review: payload.reviewId,
			by: event.actor,
			configured,
			state: payload.state,
			structured: parsed.structured,
			comments: comments.length,
		});
		const lines = [
			`## Review (${payload.state.toLowerCase()}) of ${parsed.reviewedCommit.slice(0, 12)}`,
			`From: ${event.actor} (${event.provenance})${configured ? ", the configured reviewer" : ""}`,
		];
		if (payload.body.trim()) lines.push("", payload.body.trim());
		for (const c of comments) {
			const where = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : "general";
			lines.push(
				"",
				`### Comment ${c.id}${c.inReplyTo ? ` (reply in the thread of comment ${c.inReplyTo})` : ""} on ${where}`,
				c.body,
			);
		}
		if (comments.length === 0 && !payload.body.trim()) {
			if (payload.state.toUpperCase() === "APPROVED") return null;
			lines.push("", "(no text)");
		}
		return lines.join("\n");
	}

	#applyCheck(event: CaseEvent): string | null {
		const p = event.payload as {
			checkRunId: number;
			name: string;
			headSha: string;
			conclusion: string | null;
			url: string;
			output: { title: string; summary: string; text: string };
		};
		const head = this.#currentHead();
		const classification = classifyCheck(
			this.config.checks,
			{ name: p.name, headSha: p.headSha, conclusion: p.conclusion, output: p.output },
			head,
		);
		const candidate = this.store
			.candidates()
			.find((c) =>
				this.store
					.publications()
					.some((pub) => pub.candidateId === c.id && pub.commitSha === p.headSha),
			);
		this.store.putVerification({
			id: `check:${p.checkRunId}`,
			candidateId: candidate?.id ?? null,
			treeHash: candidate?.sourceTreeHash ?? null,
			commitSha: p.headSha,
			name: p.name,
			kind: "workflow",
			environment: `github:${event.actor}`,
			outcome: outcomeOf(p.conclusion),
			classification: classification.classification,
			startedAt: event.receivedAt,
			completedAt: Date.now(),
			details: {
				reason: classification.reason,
				url: p.url,
				summary: p.output.summary.slice(0, 4000),
			},
		});
		this.store.log("check.classified", {
			name: p.name,
			head: p.headSha,
			classification: classification.classification,
			reason: classification.reason,
		});
		// Clear administrative and infrastructure noise, stale runs and successes
		// are evidence only. Anything that may need the author goes to it.
		if (!["code", "unknown"].includes(classification.classification) || p.headSha !== head)
			return null;
		return `## Check failed: ${p.name}\nFrom: ${event.actor} (${event.provenance})\nHead: ${p.headSha.slice(0, 12)}${p.url ? `\nLink: ${p.url}` : ""}\nClassification: ${classification.classification} (${classification.reason})\n\n${[p.output.title, p.output.summary, p.output.text].filter(Boolean).join("\n\n").slice(0, 6000) || "(no output)"}`;
	}

	/**
	 * Re-read the configured reviewer's reviews on the live pull request, so a
	 * lost webhook cannot drop one; any not yet seen go to the author.
	 */
	async #syncReviews(): Promise<void> {
		const pr = this.store.getMeta<number>("pr") ?? this.#identity().prNumber;
		if (!pr || this.config.reviewers.length === 0) return;
		const github = this.#github();
		const reviews = await github.request<
			Array<{
				id: number;
				user: { login: string } | null;
				body: string | null;
				commit_id: string;
				state: string;
			}>
		>("GET", github.repoPath(`/pulls/${pr}/reviews?per_page=100`));
		for (const review of reviews) {
			const login = review.user?.login ?? "";
			if (!this.config.reviewers.some((r) => r.toLowerCase() === login.toLowerCase())) continue;
			if (this.store.reviews().some((r) => r.reviewId === String(review.id))) continue;
			const inserted = this.store.insertEvent({
				deliveryId: `review-sync-${review.id}`,
				kind: "review",
				actor: login,
				provenance: "reviewer:configured",
				payload: {
					reviewId: review.id,
					body: review.body ?? "",
					commitId: review.commit_id,
					state: review.state,
					number: pr,
					synced: true,
				},
				receivedAt: Date.now(),
			});
			if (!inserted) continue;
			const event = this.store.events().at(-1)!;
			const message = await this.#applyReview(event);
			if (message && this.store.state() === "active")
				await this.#submitToAuthor(event.deliveryId, message);
		}
	}

	/**
	 * Hand one message to Pi. Pi's inbox holds it until the author reaches its
	 * next decision point; the operation ID makes resubmission harmless. The
	 * only gates are capacity (one author per repository) and the run budget.
	 */
	async #submitToAuthor(key: string, text: string): Promise<void> {
		// The bot's own milestone notices do not spend the author's run budget.
		const counted = !/^(published|ready|publication-stopped):/.test(key);
		const slot = await this.#authorSlot("acquire");
		if (!slot.granted) {
			const held = this.store.getMeta<Array<{ key: string; text: string }>>("held") ?? [];
			if (!held.some((h) => h.key === key)) this.store.setMeta("held", [...held, { key, text }]);
			this.store.log("author.held", { key, holders: slot.holders });
			await this.#schedule("reconcile", Date.now() + Math.max(this.config.reconcileMs, 30_000));
			return;
		}
		const runs = (this.store.getMeta<number>("runs") ?? 0) + (counted ? 1 : 0);
		if (counted && runs > this.config.budgets.rounds) {
			await this.#handoff(
				`runs:${runs}`,
				`the author run budget (${this.config.budgets.rounds}) is exhausted`,
				"a maintainer decides how to continue (operator resume grants more)",
			);
			return;
		}
		if (!(await this.#authorBusy())) this.store.setMeta("runStartedAt", Date.now());
		const fixtureModel = this.store.getMeta<string>("fixtureModel");
		if (fixtureModel && faultsEnabled(this.config))
			await this.harness.session().setModel(parseModelRef(fixtureModel));
		this.store.transaction(() => {
			this.store.setMeta("runGeneration", this.store.generation());
			this.store.setMeta("runs", runs);
			// Any new message answers an earlier request for a human.
			this.store.setMeta("handoff", null);
		});
		const receipt = await this.harness.submit(text, {
			operationId: `g${this.store.generation()}:${key}`,
			whenBusy: "followUp",
		});
		this.store.log("author.submit", { key, accepted: receipt.accepted, run: runs });
		await this.#schedule("reconcile", Date.now() + this.config.reconcileMs);
		await this.#schedule("report", Date.now());
	}

	#caseRecord(): string {
		const identity = this.#identity();
		const candidate = this.store.latestCandidate();
		const publication = candidate
			? this.store
					.publications()
					.filter((p) => p.candidateId === candidate.id)
					.at(-1)
			: undefined;
		const head = this.#currentHead();
		const latest = this.store.latestCheckpoint();
		const budgets = this.config.budgets;
		const pr = this.store.getMeta<number>("pr") ?? identity.prNumber;
		const lines = [
			`Repository: ${identity.repo}. ${identity.kind === "issue" ? `Issue #${identity.issueNumber}` : `Pull request #${identity.prNumber}`}${identity.issueNumber && pr ? `, published as pull request #${pr}` : ""}. Branch: ${identity.branch}.`,
			`Reporter: ${this.store.getMeta<string>("reporter") ?? "unknown"}. ${this.store.getMeta<string>("assignedBy") ? `Assigned by maintainer ${this.store.getMeta<string>("assignedBy")}.` : "Not assigned by a maintainer: the bot was offered this issue automatically when it was opened, and it is your decision whether to take it on."}`,
			`The checkout is at ${REPO_DIR}${latest ? `, based on ${latest.baseCommit}` : ""}.`,
			"",
			"Original request (untrusted text describing the work):",
			...this.store.requirements().map((r) => `${r.body}`),
			"",
			`Candidate: ${candidate ? `${candidate.id} (tree ${candidate.sourceTreeHash.slice(0, 12)})` : "none yet"}`,
			`Publication: ${publication ? `${publication.state}${publication.commitSha ? ` at ${publication.commitSha.slice(0, 12)}` : ""}${publication.prNumber ? ` in pull request #${publication.prNumber}` : ""}` : "not published"}`,
			`Current branch head: ${head ?? "none"}`,
		];
		const status = this.store.getMeta<string>("lastStatus");
		if (status) lines.push(`Last reported status: ${status}`);
		const confirmation = this.store.getMeta<{ commentId: number }>("reporterConfirmation");
		if (confirmation)
			lines.push(`The reporter confirmed the fix in comment ${confirmation.commentId}.`);
		const checks = this.store
			.verifications()
			.filter((v) => v.kind === "sandbox")
			.slice(-5);
		if (checks.length > 0)
			lines.push(
				"",
				"Recent focused checks:",
				...checks.map((v) => `- ${v.name} on tree ${v.treeHash?.slice(0, 12)}: ${v.outcome}`),
			);
		const tokens = this.store.getMeta<number>("tokens") ?? 0;
		lines.push(
			"",
			`Budgets: ${Math.max(0, budgets.rounds - (this.store.getMeta<number>("runs") ?? 0))} runs and ${Math.max(0, budgets.tokens - tokens)} tokens remain.`,
		);
		return lines.join("\n");
	}

	async #stopAuthor(): Promise<void> {
		if (this.store.identity()) await this.#authorSlot("release").catch(() => undefined);
		const aborted = this.harness.abort().catch(() => false);
		await Promise.race([aborted, new Promise((r) => setTimeout(r, this.config.budgets.cancelMs))]);
		if (this.store.identity())
			await this.#authorSandbox()
				.destroy()
				.catch(() => undefined);
		this.#sandboxVerified = false;
	}

	async #cancel(reason: string): Promise<void> {
		if (this.store.state() !== "active") return;
		this.store.transaction(() => {
			this.store.setMeta("generation", this.store.generation() + 1);
			this.store.setMeta("state", "cancelled");
		});
		this.store.log("ownership.cancelled", { reason, generation: this.store.generation() });
		await this.#stopAuthor();
		for (const candidate of this.store.candidates()) {
			const publication = this.store.publication(`publish:${candidate.id}`);
			if (
				publication &&
				!["pr-ensured", "superseded", "needs-human", "failed"].includes(publication.state)
			) {
				await this.#schedule(
					"publish",
					Date.now(),
					{ candidateId: candidate.id },
					`publish:${candidate.id}`,
				);
			}
		}
		await this.#schedule("report", Date.now());
	}

	async #authorBusy(): Promise<boolean> {
		return (await this.harness.pending()).length > 0;
	}

	/**
	 * Heartbeat with capacity and budget duties only: cap a run's time, free the
	 * author slot when Pi is idle, submit messages held for capacity, and refresh
	 * the status. It never decides what the author should do.
	 */
	async #reconcile(): Promise<LifecycleJobOutcome | void> {
		if (this.store.state() !== "active") return;
		if (await this.#authorBusy()) {
			const started = this.store.getMeta<number>("runStartedAt");
			if (started && Date.now() - started > this.config.budgets.authorMs) {
				await this.#stopAuthor();
				await this.#handoff(
					`run-timeout:${started}`,
					"the author exceeded the run time budget",
					"inspect the transcript; a new comment or operator resume continues",
				);
			}
			return { rescheduleAt: Date.now() + this.config.reconcileMs };
		}
		if (this.store.getMeta<number>("runStartedAt")) {
			this.store.setMeta("runStartedAt", null);
			this.store.log("author.idle", {});
		}
		await this.#authorSlot("release");
		const held = this.store.getMeta<Array<{ key: string; text: string }>>("held") ?? [];
		if (held.length > 0) {
			this.store.setMeta("held", []);
			for (const h of held) await this.#submitToAuthor(h.key, h.text);
		}
		await this.#schedule("report", Date.now());
		const publishing = this.store
			.publications()
			.some((p) => p.state === "intent" || p.state === "commit-created");
		if (publishing || (this.store.getMeta<unknown[]>("held") ?? []).length > 0)
			return { rescheduleAt: Date.now() + this.config.reconcileMs };
	}

	async #publishJob(candidateId: string, attempt: number): Promise<LifecycleJobOutcome | void> {
		const identity = this.#identity();
		if (this.#dryRun()) {
			this.store.log("publication.skipped", {
				candidate: candidateId,
				reason: "dry run: publication disabled",
			});
			await this.#handoff(
				`dry-run:${candidateId}`,
				`dry run complete: candidate ${candidateId} sealed; publication is disabled`,
				"export the candidate artifact and grade it",
			);
			return;
		}
		const ctx: PublishContext = {
			store: this.store,
			identity,
			config: this.config,
			github: this.#github(),
			artifacts: this.env.ARTIFACTS,
			generation: this.store.generation(),
			openSandbox: (name) =>
				openBackend(this.env, this.ctx.exports, name, {
					caseId: identity.caseId,
					repo: identity.repo,
				}),
			fault: (boundary) => this.#fault(boundary),
			registerAlias: (alias) => this.#registerAlias(alias),
			pullRequestTemplate: async () => this.store.getMeta<string | null>("prTemplate") ?? null,
			assignedBy: this.store.getMeta<string>("assignedBy") ?? null,
			model: this.config.authorModel,
			sealIntegration: (parent, base, patch, tree) =>
				this.#sealIntegration(parent, base, patch, tree),
		};
		try {
			const result = await publish(ctx, candidateId);
			if (result.state === "published") {
				this.store.setMeta("observedHead", result.commitSha);
				this.store.setMeta("pr", result.prNumber);
				// Further work starts from the published commit.
				const published = this.store.candidate(candidateId)!;
				await this.#source.run(() =>
					this.#baseCheckpoint(result.commitSha, published.sourceTreeHash),
				);
				if (this.store.state() === "active") {
					await this.#submitToAuthor(
						`published:${candidateId}`,
						`## Published\nFrom: the bot (publication)\n\nCandidate ${candidateId} was published as ${result.commitSha.slice(0, 12)} in pull request #${result.prNumber}. CI and review follow; you will hear about failures and feedback.`,
					);
				}
			} else if (result.state === "needs-human") {
				await this.#publicationStopped(candidateId, result.reason);
			}
			await this.#schedule("report", Date.now());
			await this.#schedule("reconcile", Date.now() + 500);
		} catch (error) {
			this.store.log("publication.retry", {
				candidate: candidateId,
				attempt,
				error: errorMessage(error),
			});
			if (attempt >= 6) {
				await this.#handoff(
					`publish:${candidateId}:exhausted`,
					`publication failed repeatedly: ${errorMessage(error)}`,
					"inspect the publication receipt and retry with the operator resume command",
				);
				return;
			}
			await this.#schedule(
				"publish",
				Date.now() + 2 ** attempt * 5000,
				{ candidateId, attempt: attempt + 1 },
				`publish:${candidateId}`,
			);
		}
	}

	/**
	 * A branch-level publication stop goes to the author with its preserved
	 * patch, so it can rebuild the change on the current head. Integrity
	 * failures are bot faults and go to a human.
	 */
	async #publicationStopped(candidateId: string, reason: string): Promise<void> {
		if (/tree|integrity|materialization/i.test(reason) || this.store.state() !== "active") {
			await this.#handoff(
				`publish:${candidateId}:handoff`,
				reason,
				"inspect the publication receipt and the branch",
			);
			return;
		}
		const identity = this.#identity();
		const github = this.#github();
		const head = await github.branchHead(identity.branch);
		if (head)
			await this.#source.run(async () => this.#baseCheckpoint(head, await github.commitTree(head)));
		const candidate = this.store.candidate(candidateId)!;
		const patch = await readArtifact(
			this.env.ARTIFACTS,
			candidate.artifactKey,
			candidate.artifactDigest,
		)
			.then((b) => new TextDecoder().decode(b))
			.catch(() => "");
		await this.#submitToAuthor(
			`publication-stopped:${candidateId}`,
			`## Publication stopped\nFrom: the bot (publication)\n\n${reason}\n\nYour checkout now starts from the branch head ${head?.slice(0, 12) ?? "(unknown)"}. Rebuild your change on top of it and submit a new candidate. Your previous change, preserved as candidate ${candidateId}:\n\n\`\`\`diff\n${patch.slice(0, 20_000)}\n\`\`\``,
		);
	}

	async #observe(): Promise<void> {
		const pr = this.store.getMeta<number>("pr") ?? this.#identity().prNumber;
		if (!pr) return;
		await this.#syncReviews().catch((error: unknown) =>
			this.store.log("reviews.sync-failed", { error: errorMessage(error) }),
		);
		const github = this.#github();
		const data = await github.request<{
			head: { sha: string };
			mergeable: boolean | null;
			state: string;
			merged: boolean;
		}>("GET", github.repoPath(`/pulls/${pr}`));
		this.store.setMeta("observedHead", data.head.sha);
		this.store.setMeta("mergeability", { head: data.head.sha, mergeable: data.mergeable });
		// Reconcile check runs whose callbacks may have been lost.
		const runs = await github.request<{
			check_runs: Array<{
				id: number;
				name: string;
				status: string;
				conclusion: string | null;
				head_sha: string;
				html_url: string;
				app?: { slug?: string };
				output: { title: string | null; summary: string | null; text: string | null };
			}>;
		}>("GET", github.repoPath(`/commits/${data.head.sha}/check-runs?per_page=100`));
		for (const run of runs.check_runs) {
			if (run.name === STATUS_CHECK_NAME) continue;
			const id = `check:${run.id}`;
			const known = this.store.verification(id);
			if (run.status !== "completed") {
				if (!known)
					this.store.putVerification({
						id,
						candidateId: null,
						treeHash: null,
						commitSha: run.head_sha,
						name: run.name,
						kind: "workflow",
						environment: `github:${run.app?.slug ?? "github"}`,
						outcome: run.status === "queued" ? "queued" : "running",
						classification: null,
						startedAt: Date.now(),
						completedAt: null,
						details: { url: run.html_url },
					});
				continue;
			}
			if (known && known.completedAt) continue;
			const classification = classifyCheck(
				this.config.checks,
				{
					name: run.name,
					headSha: run.head_sha,
					conclusion: run.conclusion,
					output: {
						title: run.output.title ?? "",
						summary: run.output.summary ?? "",
						text: run.output.text ?? "",
					},
				},
				data.head.sha,
			);
			this.store.putVerification({
				id,
				candidateId: null,
				treeHash: null,
				commitSha: run.head_sha,
				name: run.name,
				kind: "workflow",
				environment: `github:${run.app?.slug ?? "github"}`,
				outcome: outcomeOf(run.conclusion),
				classification: classification.classification,
				startedAt: Date.now(),
				completedAt: Date.now(),
				details: { reason: classification.reason, url: run.html_url, reconciled: true },
			});
			this.store.log("check.reconciled", {
				name: run.name,
				classification: classification.classification,
			});
		}
	}

	async status(): Promise<StatusReport> {
		await this.lifecycle.start();
		return computeStatus({
			state: this.store.state(),
			authorBusy: this.store.state() === "active" && (await this.#authorBusy()),
			handoff: this.store.getMeta<Handoff | null>("handoff") ?? undefined,
			candidates: this.store.candidates(),
			publications: this.store.publications(),
			verifications: this.store.verifications(),
			reviews: this.store.reviews(),
			observedHead: this.store.getMeta<string>("observedHead") ?? null,
			mergeability: this.store.getMeta("mergeability"),
			policy: this.config.checks,
		});
	}

	async #reportJob(): Promise<LifecycleJobOutcome | void> {
		if (!this.store.identity()) return;
		try {
			await this.#observe();
		} catch (error) {
			this.store.log("observe.failed", { error: errorMessage(error) });
		}
		const report = await this.status();
		const last = this.store.getMeta<string>("lastStatus");
		if (last !== report.status) {
			this.store.setMeta("lastStatus", report.status);
			this.store.log("status", { status: report.status, reasons: report.reasons });
			if (report.status === "ready-for-human" && report.head && this.store.state() === "active") {
				await this.#submitToAuthor(
					`ready:${report.head}`,
					`## Ready for human review\nFrom: the bot (status)\n\nThe current head ${report.head.slice(0, 12)} passed the required checks, the reviewer's latest review is clean, and it merges cleanly. A maintainer still has to approve and merge.`,
				);
			}
		}
		// One progress comment: on the issue until a pull request exists, then on the pull request.
		const identity = this.#identity();
		const pr = this.store.getMeta<number>("pr") ?? identity.prNumber;
		const target = pr ?? identity.issueNumber;
		// Quiet until engaged: an automatically admitted or declined issue gets no
		// progress comment until the author has a plan or a candidate.
		const engaged =
			!!this.store.getMeta("statusComment") ||
			(this.store.state() !== "declined" &&
				(!this.store.getMeta<boolean>("autoIntake") ||
					!!this.store.getMeta("workPlan") ||
					!!this.store.latestCandidate()));
		if (target && engaged && !this.#dryRun()) {
			try {
				await this.#fault("report-failure");
				const body = renderStatus(identity, report, {
					plan: this.store.getMeta<WorkPlan>("workPlan"),
					prNumber: pr ?? null,
					reporterConfirmed: !!this.store.getMeta("reporterConfirmation"),
				});
				await this.#upsertStatusComment(target, body);
			} catch (error) {
				this.store.log("report.failed", { error: errorMessage(error) });
				return { rescheduleAt: Date.now() + 60_000 };
			}
		}
		if (pr && report.head && !this.#dryRun()) {
			try {
				await this.#upsertStatusCheck(report);
			} catch (error) {
				// Optional: an installation without checks:write still gets the comment.
				this.store.log("status-check.failed", { error: errorMessage(error) });
			}
		}
		if (report.status === "waiting-for-checks" || report.status === "candidate-published")
			return { rescheduleAt: Date.now() + Math.max(this.config.reconcileMs, 120_000) };
	}

	/** One check run per head; a completed run is updated, or replaced if work resumes. */
	async #upsertStatusCheck(report: StatusReport): Promise<void> {
		const head = report.head!;
		const check = renderStatusCheck(report);
		const hash = await sha256Hex(JSON.stringify(check));
		const stored = this.store.getMeta<{
			id: number;
			head: string;
			hash: string;
			completed: boolean;
		}>("statusCheck");
		if (stored?.head === head && stored.hash === hash) return;
		const github = this.#github();
		if (stored && stored.head !== head && !stored.completed) {
			await github.request("PATCH", github.repoPath(`/check-runs/${stored.id}`), {
				status: "completed",
				conclusion: "neutral",
				output: { title: "Superseded", summary: `Superseded by ${head.slice(0, 12)}.` },
			});
		}
		const fields = {
			status: check.status,
			...(check.conclusion ? { conclusion: check.conclusion } : {}),
			output: { title: check.title, summary: check.summary },
		};
		let id =
			stored?.head === head && (!stored.completed || check.status === "completed")
				? stored.id
				: undefined;
		if (id) await github.request("PATCH", github.repoPath(`/check-runs/${id}`), fields);
		else
			id = (
				await github.request<{ id: number }>("POST", github.repoPath("/check-runs"), {
					name: STATUS_CHECK_NAME,
					head_sha: head,
					...fields,
				})
			).id;
		this.store.setMeta("statusCheck", { id, head, hash, completed: check.status === "completed" });
	}

	async #upsertStatusComment(target: number, body: string): Promise<void> {
		const hash = await sha256Hex(body);
		const stored = this.store.getMeta<{ id: number; hash: string; target?: number }>(
			"statusComment",
		);
		const identity = this.#identity();
		const github = this.#github();
		if (stored && stored.target !== undefined && stored.target !== target) {
			// The work moved to the pull request: leave a pointer on the issue.
			await github.request("PATCH", github.repoPath(`/issues/comments/${stored.id}`), {
				body: renderMovedToPullRequest(identity, target),
			});
			this.store.log("progress.moved", { from: stored.target, to: target });
		} else if (stored?.hash === hash) return;
		let id = stored && stored.target === target ? stored.id : undefined;
		if (!id) {
			const marker = statusMarker(identity.caseId);
			const comments = await github.request<Array<{ id: number; body: string }>>(
				"GET",
				github.repoPath(`/issues/${target}/comments?per_page=100`),
			);
			id = comments.find((c) => c.body.includes(marker))?.id;
		}
		if (id) await github.request("PATCH", github.repoPath(`/issues/comments/${id}`), { body });
		else
			id = (
				await github.request<{ id: number }>(
					"POST",
					github.repoPath(`/issues/${target}/comments`),
					{ body },
				)
			).id;
		this.store.setMeta("statusComment", { id, hash, target });
	}

	// ---------------- operator interface ----------------

	async inspect(options: { transcript?: boolean } = {}): Promise<Record<string, unknown>> {
		await this.lifecycle.start();
		const identity = this.store.identity();
		if (!identity) return { exists: false };
		return {
			exists: true,
			identity,
			state: this.store.state(),
			generation: this.store.generation(),
			round: this.store.getMeta("round"),
			handoff: this.store.getMeta("handoff"),
			triage: this.store.getMeta("triage") ?? null,
			status: await this.status(),
			tokens: this.store.getMeta("tokens") ?? 0,
			cacheReadTokens: this.store.getMeta("cacheReadTokens") ?? 0,
			requirements: this.store.requirements(),
			events: this.store.events(),
			checkpoints: this.store.checkpoints(),
			candidates: this.store.candidates(),
			publications: this.store.publications(),
			verifications: this.store.verifications(),
			reviews: this.store.reviews(),
			reporterConfirmation: this.store.getMeta("reporterConfirmation") ?? null,
			operations: this.store.operations(),
			pending: await this.harness.pending(),
			faults: this.store.armedFaults(),
			log: this.store.logEntries(),
			...(options.transcript ? { transcript: await this.harness.messages() } : {}),
		};
	}

	async operatorCancel(actor: string): Promise<void> {
		await this.lifecycle.start();
		await this.#cancel(`operator ${actor}`);
	}

	/** Explicitly resume eligible interrupted work: publication of the latest candidate, and reconciliation. */
	async operatorResume(actor: string, options: { newRound?: string } = {}): Promise<void> {
		await this.lifecycle.start();
		this.store.log("operator.resume", { actor, newRound: !!options.newRound });
		// Resuming is the operator's explicit answer to any handoff.
		this.store.setMeta("handoff", null);
		const candidate = this.store.latestCandidate();
		const publication = candidate ? this.store.publication(`publish:${candidate.id}`) : undefined;
		if (
			candidate &&
			(!publication ||
				publication.state === "intent" ||
				publication.state === "commit-created" ||
				publication.state === "ref-updated")
		) {
			await this.#schedule(
				"publish",
				Date.now(),
				{ candidateId: candidate.id },
				`publish:${candidate.id}`,
			);
		}
		if (options.newRound) {
			await this.deliver({
				deliveryId: `operator-${Date.now()}`,
				caseId: this.#identity().caseId,
				kind: "operator-round",
				actor,
				provenance: "operator",
				payload: { note: options.newRound },
			});
			this.store.addRequirement({
				source: "operator",
				actor,
				body: options.newRound,
				createdAt: Date.now(),
			});
		}
		await this.#schedule("reconcile", Date.now());
	}

	/** One read-only model turn with no sandbox, for deployment smoke checks. */
	async modelSmoke(prompt: string, model?: string): Promise<Record<string, unknown>> {
		await this.lifecycle.start();
		if (model) await this.harness.session().setModel(parseModelRef(model));
		const started = Date.now();
		const result = await this.harness.prompt(prompt, { operationId: `smoke-${started}` });
		const assistant = result.messages
			.flatMap(
				(entry) => ((entry as { model?: unknown[] }).model ?? []) as Array<Record<string, unknown>>,
			)
			.filter((m) => m.role === "assistant")
			.at(-1);
		return {
			status: result.status,
			reason: result.reason,
			text: result.text,
			elapsedMs: Date.now() - started,
			requestedModel: model ?? this.config.authorModel,
			reported: assistant
				? {
						provider: assistant.provider,
						model: assistant.model,
						responseModel: assistant.responseModel,
						usage: assistant.usage,
						diagnostics: assistant.diagnostics,
					}
				: null,
		};
	}

	/** Staging only: fixture overrides recorded by the authenticated eval controller. */
	async setFixture(fixture: { model?: string }): Promise<{ accepted: boolean }> {
		if (!faultsEnabled(this.config)) return { accepted: false };
		if (fixture.model) this.store.setMeta("fixtureModel", fixture.model);
		this.store.log("fixture.set", fixture);
		return { accepted: true };
	}

	/**
	 * Staging only: admit a case directly from the operator for a public
	 * repository at a pinned commit, with publication disabled. A smoke check
	 * for the real author, sandbox and checkpoints; never an evaluation score.
	 */
	async operatorDryRun(
		input: {
			identity: CaseIdentity;
			title: string;
			body: string;
			baseCommit: string;
			repository?: DryRun["repository"];
			model?: string;
		},
		actor: string,
	): Promise<{ accepted: boolean }> {
		if (!faultsEnabled(this.config)) return { accepted: false };
		await this.lifecycle.start();
		this.store.setMeta("dryRun", {
			baseCommit: input.baseCommit,
			repository: input.repository ?? {},
		});
		if (input.model) this.store.setMeta("fixtureModel", input.model);
		const result = await this.deliver({
			deliveryId: `dry-run-${Date.now()}`,
			caseId: input.identity.caseId,
			kind: "assigned",
			actor,
			provenance: "operator:dry-run",
			payload: { title: input.title, body: input.body, url: "" },
			identity: input.identity,
		});
		return { accepted: result.accepted };
	}

	async artifact(candidateId: string): Promise<string | null> {
		const candidate = this.store.candidate(candidateId);
		if (!candidate) return null;
		return new TextDecoder().decode(
			await readArtifact(this.env.ARTIFACTS, candidate.artifactKey, candidate.artifactDigest),
		);
	}

	/**
	 * Delete this case's checkpoint artifacts that no checkpoint or candidate
	 * references and that are older than the grace period. Referenced source
	 * is never deleted.
	 */
	async collectGarbage(
		graceMs = 7 * 24 * 60 * 60_000,
	): Promise<{ deleted: string[]; kept: number }> {
		await this.lifecycle.start();
		const identity = this.store.identity();
		if (!identity) return { deleted: [], kept: 0 };
		const referenced = new Set([
			...this.store.checkpoints().map((c) => c.artifactKey),
			...this.store.candidates().map((c) => c.artifactKey),
		]);
		const deleted: string[] = [];
		let kept = 0;
		let cursor: string | undefined;
		do {
			const page = await this.env.ARTIFACTS.list({ prefix: `cases/${identity.caseId}/`, cursor });
			for (const object of page.objects) {
				if (referenced.has(object.key) || Date.now() - object.uploaded.getTime() < graceMs) kept++;
				else deleted.push(object.key);
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		if (deleted.length > 0) await this.env.ARTIFACTS.delete(deleted);
		this.store.log("gc", { deleted: deleted.length, kept });
		return { deleted, kept };
	}

	async armFault(boundary: string, attempt?: string): Promise<{ armed: boolean }> {
		if (!faultsEnabled(this.config)) return { armed: false };
		this.store.armFault(boundary, attempt);
		this.store.log("fault.armed", { boundary, attempt });
		return { armed: true };
	}
}
