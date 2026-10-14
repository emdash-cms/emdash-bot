// One case covers an issue and its pull request, or an adopted pull request,
// through implementation and revision. Pi Durable owns the author's turns and
// tools through PiHarness; this object owns admission, ownership generations,
// source checkpoints, candidates, publication and readiness.

import { DurableObject } from "cloudflare:workers";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import authorSkill from "../../skills/emdash-author/SKILL.md?raw";
import { type BotConfig, faultsEnabled, readConfig } from "../config.ts";
import { type ExecBackend, REPO_DIR, openBackend } from "../execution/backend.ts";
import { SandboxExecutionEnv } from "../execution/env.ts";
import { writeToken } from "../github/auth.ts";
import { classifyCheck, outcomeOf } from "../github/checks.ts";
import { GitHubClient } from "../github/client.ts";
import { type PublishContext, publish, readArtifact } from "../github/publisher.ts";
import { parseReview } from "../github/review.ts";
import { renderStatus, statusMarker } from "../reports/render.ts";
import { type StatusReport, computeStatus, outstandingFindings } from "../reports/status.ts";
import { setupModels } from "../runtime/models.ts";
import { DEFAULT_PRIVILEGED_PREFIXES, PatchRejected, validatePatch } from "../source/patch.ts";
import {
	captureSource,
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
	Finding,
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

interface Handoff {
	readonly reason: string;
	readonly nextAction: string;
	readonly at: number;
	readonly round: number;
}

interface RoundState {
	readonly round: number;
	readonly generation: number;
	readonly operationId: string;
	readonly startedAt: number;
	readonly baseCommit: string;
	open: boolean;
	candidateId?: string;
	handedOff?: boolean;
	respondedToFindings?: boolean;
}

const AUTHOR_KINDS = new Set(["assigned", "direction", "operator-round"]);

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
						settings: { retry: { maxRetries: 3 }, toolExecution: "sequential" },
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
		const payload = (context.job.payload ?? {}) as Record<string, unknown>;
		switch (context.job.fn) {
			case "reconcile":
				return this.#reconcile();
			case "publish":
				return this.#publishJob(String(payload.candidateId), Number(payload.attempt ?? 0));
			case "report":
				return this.#reportJob();
		}
	}

	async #schedule(
		fn: "reconcile" | "report" | "publish",
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
		return this.config.repositories.find((r) => r.id === this.#identity().repoId);
	}

	async #ensureSandbox(): Promise<void> {
		const latest = this.store.latestCheckpoint();
		if (!latest) throw new Error("no source checkpoint exists yet");
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
			guard: () => this.#guard(),
			ready: () => this.#source.run(() => this.#ensureSandbox()),
			mutate: <T>(opId: string, tool: string, fn: () => Promise<T>) => this.#mutate(opId, tool, fn),
			search: (pattern, path, glob) => this.#search(pattern, path, glob),
			listFiles: (path) => this.#listFiles(path),
			runCheck: (opId, name, args) => this.#runCheck(opId, name, args),
			submitCandidate: (opId, title, summary) => this.#submitCandidate(opId, title, summary),
			handoff: (opId, reason, nextAction) => this.#handoff(opId, reason, nextAction),
			respondToFinding: (id, disposition, note) => this.#respondToFinding(id, disposition, note),
			caseStatus: () => this.#caseRecord(),
			focusedChecks: () => this.#repoConfig()?.focusedChecks ?? {},
			recordUsage: (tokens) =>
				this.store.setMeta("tokens", (this.store.getMeta<number>("tokens") ?? 0) + tokens),
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

	#guard(): string | undefined {
		const state = this.store.state();
		if (state !== "active") return `the case is ${state ?? "not admitted"}; tool use is refused`;
		const round = this.store.getMeta<RoundState>("round");
		if (!round || round.generation !== this.store.generation())
			return "this run belongs to an obsolete ownership generation";
		const budgets = this.config.budgets;
		if (Date.now() - round.startedAt > budgets.authorMs)
			return "the author time budget for this round is exhausted";
		const created = this.store.getMeta<number>("createdAt") ?? Date.now();
		if (Date.now() - created > budgets.caseMs) return "the case time budget is exhausted";
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
				const round = this.store.getMeta<RoundState>("round");
				if (round) this.store.setMeta("round", { ...round, candidateId: sealed.id });
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
		const round = this.store.getMeta<RoundState>("round");
		const handoff: Handoff = { reason, nextAction, at: Date.now(), round: round?.round ?? 0 };
		this.store.transaction(() => {
			this.store.setMeta("handoff", handoff);
			this.store.putOperation(opId, "handoff", this.store.generation(), "completed", handoff);
			if (round) this.store.setMeta("round", { ...round, handedOff: true });
		});
		this.store.log("handoff", { reason, nextAction });
		await this.#schedule("reconcile", Date.now() + 2000);
	}

	#respondToFinding(id: string, disposition: "addressed" | "disputed", note: string): Finding {
		const finding = this.store.updateFinding(
			id,
			disposition === "addressed" ? "addressed-by-author" : "disputed",
			"author",
			note,
		);
		if (!finding) throw new Error(`unknown finding ${id}`);
		const round = this.store.getMeta<RoundState>("round");
		if (round) this.store.setMeta("round", { ...round, respondedToFindings: true });
		this.store.log("finding.author-disposition", { id, disposition });
		return finding;
	}

	// ---------------- GitHub ----------------

	#github(): GitHubClient {
		return new GitHubClient(
			this.config.githubApiUrl,
			() => writeToken(this.env, this.config),
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
		const needsAuthor = await this.#apply(event, delivery);
		if (!needsAuthor) this.store.markConsumed([event.seq], 0);
		if (this.store.state() === "active") await this.#schedule("reconcile", Date.now() + 500);
		return { accepted: true, duplicate: false, caseId: delivery.caseId };
	}

	/** Apply an admitted event to the case record. Returns whether it needs author work. */
	async #apply(event: CaseEvent, delivery: CaseDelivery): Promise<boolean> {
		const payload = event.payload;
		switch (event.kind) {
			case "assigned": {
				const state = this.store.state();
				if (state === "active") return false;
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
					}
					this.store.setMeta("generation", this.store.generation() + 1);
					this.store.setMeta("state", "active");
					this.store.setMeta("assignedBy", event.actor);
					this.store.setMeta("handoff", null);
				});
				this.store.log("ownership.assigned", {
					generation: this.store.generation(),
					by: event.actor,
				});
				return true;
			}
			case "operator-round":
				this.store.setMeta("handoff", null);
				return this.store.state() === "active";
			case "unassigned":
				await this.#cancel(`unassigned by ${event.actor}`);
				return false;
			case "direction":
				this.store.addRequirement({
					source: str(payload.url ?? ""),
					actor: event.actor,
					body: str(payload.body ?? ""),
					createdAt: Date.now(),
				});
				this.store.setMeta("handoff", null);
				return this.store.state() === "active";
			case "review":
				return this.#applyReview(event);
			case "check":
				return this.#applyCheck(event);
			case "head-changed":
				this.store.setMeta("observedHead", String(payload.after));
				this.store.log("branch.advanced", { by: event.actor, head: payload.after });
				return false;
			case "pr-opened":
				return false;
			case "closed": {
				const isIssue = payload.issue === true;
				if (isIssue && this.store.publications().some((p) => p.state === "pr-ensured"))
					return false;
				this.store.setMeta("state", "terminal");
				this.store.setMeta("generation", this.store.generation() + 1);
				this.store.log("case.terminal", { merged: payload.merged === true, issue: isIssue });
				await this.#stopAuthor();
				await this.#schedule("report", Date.now());
				return false;
			}
			default:
				return false;
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

	#applyReview(event: CaseEvent): boolean {
		const payload = event.payload as {
			reviewId: number;
			body: string;
			commitId: string;
			state: string;
		};
		const parsed = parseReview(payload.body, payload.reviewId, payload.commitId, payload.state);
		const fresh = this.store.putReview({
			reviewId: String(payload.reviewId),
			reviewer: event.actor,
			commit: parsed.reviewedCommit,
			state: payload.state,
			structured: parsed.structured,
			receivedAt: Date.now(),
		});
		if (!fresh) return false;
		const at = Date.now();
		for (const f of parsed.findings) {
			const existing = this.store.finding(f.id);
			if (!existing) {
				this.store.putFinding({
					id: f.id,
					reviewId: String(payload.reviewId),
					reviewedCommit: parsed.reviewedCommit,
					path: f.path,
					line: f.line,
					severity: f.severity,
					title: f.title,
					body: f.body,
					actionable: f.actionable,
					status: "open",
					authorNote: null,
					updatedAt: at,
					history: [{ at, status: "open", by: event.actor, commit: parsed.reviewedCommit }],
				});
			} else if (existing.status !== "open") {
				// The reviewer still reports it on the new head.
				this.store.updateFinding(
					f.id,
					"open",
					event.actor,
					"reported again",
					parsed.reviewedCommit,
				);
			}
		}
		for (const d of parsed.dispositions) {
			const status = d.status === "open" ? "open" : "confirmed-by-reviewer";
			if (this.store.finding(d.id))
				this.store.updateFinding(
					d.id,
					status,
					event.actor,
					d.note ?? d.status,
					parsed.reviewedCommit,
				);
		}
		this.store.log("review.recorded", {
			review: payload.reviewId,
			commit: parsed.reviewedCommit,
			structured: parsed.structured,
			findings: parsed.findings.length,
			dispositions: parsed.dispositions.length,
		});
		return this.store.findings().some((f) => f.actionable && f.status === "open");
	}

	#applyCheck(event: CaseEvent): boolean {
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
		if (classification.classification !== "code" || p.headSha !== head) return false;
		const repaired = this.store.getMeta<string[]>("repairsRequested") ?? [];
		const key = `${p.name}@${p.headSha}`;
		if (repaired.includes(key)) return false;
		this.store.setMeta("repairsRequested", [...repaired, key]);
		return true;
	}

	// ---------------- rounds ----------------

	async #startRound(): Promise<void> {
		const identity = this.#identity();
		const previous = this.store.getMeta<RoundState>("round");
		const roundNumber = (previous?.round ?? 0) + 1;
		const pending = this.store.pendingEvents();
		if (roundNumber > this.config.budgets.rounds) {
			this.store.markConsumed(
				pending.map((e) => e.seq),
				-1,
			);
			await this.#handoff(
				`round:${roundNumber}:budget`,
				`the revision round budget (${this.config.budgets.rounds}) is exhausted`,
				"a maintainer reviews the case and decides how to continue",
			);
			return;
		}
		const github = this.#github();
		// Base: the current branch head when one exists, otherwise the default branch.
		let base = this.#currentHead();
		if (!base && identity.kind === "pr") base = (await github.branchHead(identity.branch)) ?? null;
		const defaultHead = await github.branchHead(identity.defaultBranch);
		if (!defaultHead) throw new Error(`default branch ${identity.defaultBranch} not found`);
		base ??= defaultHead;
		if (!this.store.getMeta("instructions")) {
			const agents = (await this.#fileAt("AGENTS.md", defaultHead)) ?? "";
			this.store.setMeta("instructions", { commit: defaultHead, text: agents.slice(0, 40_000) });
			this.store.setMeta(
				"prTemplate",
				await this.#fileAt(".github/PULL_REQUEST_TEMPLATE.md", defaultHead),
			);
		}
		const latest = this.store.latestCheckpoint();
		if (!latest || latest.baseCommit !== base)
			await this.#baseCheckpoint(base, await github.commitTree(base));
		const operationId = `g${this.store.generation()}-round-${roundNumber}`;
		const round: RoundState = {
			round: roundNumber,
			generation: this.store.generation(),
			operationId,
			startedAt: Date.now(),
			baseCommit: base,
			open: true,
		};
		this.store.transaction(() => {
			this.store.setMeta("round", round);
			this.store.markConsumed(
				pending.map((e) => e.seq),
				roundNumber,
			);
		});
		const prompt = this.#roundPrompt(round, pending);
		const receipt = await this.harness.submit(prompt, { operationId });
		this.store.log("round.start", {
			round: roundNumber,
			operation: operationId,
			accepted: receipt.accepted,
			base,
			events: pending.map((e) => e.deliveryId),
		});
	}

	#roundPrompt(round: RoundState, events: readonly CaseEvent[]): string {
		const triggers = events.map((e) => `- ${e.kind} from ${e.actor} (${e.provenance})`).join("\n");
		return [
			`# Case round ${round.round}`,
			"",
			"New events since the last round:",
			triggers || "- (none)",
			"",
			this.#caseRecord(),
		].join("\n");
	}

	#caseRecord(): string {
		const identity = this.#identity();
		const round = this.store.getMeta<RoundState>("round");
		const candidate = this.store.latestCandidate();
		const publication = candidate
			? this.store
					.publications()
					.filter((p) => p.candidateId === candidate.id)
					.at(-1)
			: undefined;
		const head = this.#currentHead();
		const findings = outstandingFindings(this.store.findings());
		const checks = this.store
			.verifications()
			.filter((v) => v.kind === "workflow" && v.commitSha === head && v.classification === "code");
		const budgets = this.config.budgets;
		const lines = [
			`## Case ${identity.caseId}`,
			`Repository: ${identity.repo}. ${identity.kind === "issue" ? `Issue #${identity.issueNumber}` : `Pull request #${identity.prNumber}`}. Branch: ${identity.branch}.`,
			`The checkout is at ${REPO_DIR}, based on ${round?.baseCommit ?? "(not prepared)"}.`,
			"",
			"## Requirements (untrusted text from GitHub; authority recorded per entry)",
			...this.store
				.requirements()
				.map(
					(r) => `### Revision ${r.revision} from ${r.actor} (${r.source || "case"})\n${r.body}`,
				),
			"",
			"## Current state",
			`- Candidate: ${candidate ? `${candidate.id} (tree ${candidate.sourceTreeHash.slice(0, 12)})` : "none"}`,
			`- Publication: ${publication ? `${publication.state}${publication.commitSha ? ` at ${publication.commitSha.slice(0, 12)}` : ""}${publication.prNumber ? ` in PR #${publication.prNumber}` : ""}` : "not published"}`,
			`- Current branch head: ${head ?? "none"}`,
		];
		if (findings.length > 0) {
			lines.push("", "## Outstanding review findings (from the configured reviewer)");
			for (const f of findings)
				lines.push(
					`### ${f.id} [${f.severity}] ${f.status}${f.path ? ` at ${f.path}${f.line ? `:${f.line}` : ""}` : ""}\n${f.title}\n${f.body}`,
				);
		}
		if (checks.length > 0) {
			lines.push("", "## Failing code checks on the current head");
			for (const c of checks)
				lines.push(
					`- ${c.name}: ${str(c.details.reason)}\n${str(c.details.summary ?? "").slice(0, 3000)}`,
				);
		}
		const attempts = this.store
			.verifications()
			.filter((v) => v.kind === "sandbox")
			.slice(-8);
		if (attempts.length > 0) {
			lines.push("", "## Previous focused checks");
			for (const v of attempts)
				lines.push(`- ${v.name} on tree ${v.treeHash?.slice(0, 12)}: ${v.outcome}`);
		}
		const handoff = this.store.getMeta<Handoff | null>("handoff");
		if (handoff) lines.push("", `## Previous handoff\n${handoff.reason}`);
		const tokens = this.store.getMeta<number>("tokens") ?? 0;
		lines.push(
			"",
			"## Remaining budgets",
			`- Rounds: ${budgets.rounds - (round?.round ?? 0)} after this one`,
			`- Author time this round: ${Math.round(budgets.authorMs / 60_000)} minutes`,
			`- Tokens: ${Math.max(0, budgets.tokens - tokens)}`,
		);
		return lines.join("\n");
	}

	async #stopAuthor(): Promise<void> {
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

	async #reconcile(): Promise<LifecycleJobOutcome | void> {
		if (this.store.state() !== "active") return;
		const round = this.store.getMeta<RoundState>("round");
		if (await this.#authorBusy()) {
			if (round && Date.now() - round.startedAt > this.config.budgets.authorMs) {
				await this.#stopAuthor();
				await this.#handoff(
					`round:${round.round}:timeout`,
					"the author exceeded the round time budget",
					"inspect the transcript and resume or reassign",
				);
			}
			return { rescheduleAt: Date.now() + this.config.reconcileMs };
		}
		if (round?.open) {
			const current = this.store.getMeta<RoundState>("round")!;
			this.store.setMeta("round", { ...current, open: false });
			const result = await this.harness.wait(current.operationId).catch(() => undefined);
			this.store.log("round.end", {
				round: current.round,
				status: result?.status,
				reason: result?.reason,
				candidate: current.candidateId ?? null,
				handedOff: current.handedOff ?? false,
			});
			if (!current.candidateId && !current.handedOff && !current.respondedToFindings) {
				await this.#handoff(
					`round:${current.round}:no-outcome`,
					`the author ended round ${current.round} without submitting a candidate or handing off${result?.reason ? ` (${result.reason})` : ""}`,
					"inspect the transcript; resume with a direction or reassign",
				);
			}
		}
		let handoff = this.store.getMeta<Handoff | null>("handoff");
		// An unconsumed maintainer direction or operator round arrived after the
		// last round started, so it answers any handoff that round recorded.
		if (
			handoff &&
			this.store.pendingEvents().some((e) => e.kind === "direction" || e.kind === "operator-round")
		) {
			this.store.setMeta("handoff", null);
			this.store.log("handoff.answered", { reason: handoff.reason });
			handoff = null;
		}
		const pending = this.store
			.pendingEvents()
			.filter((e) => AUTHOR_KINDS.has(e.kind) || e.kind === "review" || e.kind === "check");
		const publishing = this.store
			.publications()
			.some((p) => p.state === "intent" || p.state === "commit-created");
		const unpublished =
			this.store.latestCandidate() &&
			!this.store.publication(`publish:${this.store.latestCandidate()!.id}`);
		if (pending.length > 0 && !handoff && !publishing && !unpublished) {
			try {
				await this.#startRound();
			} catch (error) {
				this.store.log("round.start-failed", { error: errorMessage(error) });
				return { rescheduleAt: Date.now() + Math.max(this.config.reconcileMs, 30_000) };
			}
			return { rescheduleAt: Date.now() + this.config.reconcileMs };
		}
		await this.#schedule("report", Date.now());
		if (publishing || unpublished) return { rescheduleAt: Date.now() + this.config.reconcileMs };
	}

	async #publishJob(candidateId: string, attempt: number): Promise<LifecycleJobOutcome | void> {
		const identity = this.#identity();
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
			assignedBy: this.store.getMeta<string>("assignedBy") ?? "maintainer",
			model: this.config.authorModel,
			sealIntegration: (parent, base, patch, tree) =>
				this.#sealIntegration(parent, base, patch, tree),
		};
		try {
			const result = await publish(ctx, candidateId);
			if (result.state === "published") {
				this.store.setMeta("observedHead", result.commitSha);
				this.store.setMeta("pr", result.prNumber);
			} else if (result.state === "needs-human") {
				await this.#handoff(
					`publish:${candidateId}:handoff`,
					result.reason,
					"inspect the publication receipt and the branch",
				);
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

	async #observe(): Promise<void> {
		const pr = this.store.getMeta<number>("pr") ?? this.#identity().prNumber;
		if (!pr) return;
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
			authorBusy:
				this.store.state() === "active" &&
				((await this.#authorBusy()) || this.store.getMeta<RoundState>("round")?.open === true),
			handoff: this.store.getMeta<Handoff | null>("handoff") ?? undefined,
			candidates: this.store.candidates(),
			publications: this.store.publications(),
			verifications: this.store.verifications(),
			findings: this.store.findings(),
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
		}
		const pr = this.store.getMeta<number>("pr") ?? this.#identity().prNumber;
		if (pr) {
			try {
				await this.#fault("report-failure");
				await this.#upsertStatusComment(pr, renderStatus(this.#identity(), report));
			} catch (error) {
				this.store.log("report.failed", { error: errorMessage(error) });
				return { rescheduleAt: Date.now() + 60_000 };
			}
		}
		if (report.status === "waiting-for-checks" || report.status === "candidate-published")
			return { rescheduleAt: Date.now() + Math.max(this.config.reconcileMs, 120_000) };
	}

	async #upsertStatusComment(pr: number, body: string): Promise<void> {
		const hash = await sha256Hex(body);
		const stored = this.store.getMeta<{ id: number; hash: string }>("statusComment");
		if (stored?.hash === hash) return;
		const github = this.#github();
		let id = stored?.id;
		if (!id) {
			const marker = statusMarker(this.#identity().caseId);
			const comments = await github.request<Array<{ id: number; body: string }>>(
				"GET",
				github.repoPath(`/issues/${pr}/comments?per_page=100`),
			);
			id = comments.find((c) => c.body.includes(marker))?.id;
		}
		if (id) await github.request("PATCH", github.repoPath(`/issues/comments/${id}`), { body });
		else
			id = (
				await github.request<{ id: number }>("POST", github.repoPath(`/issues/${pr}/comments`), {
					body,
				})
			).id;
		this.store.setMeta("statusComment", { id, hash });
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
			status: await this.status(),
			tokens: this.store.getMeta("tokens") ?? 0,
			requirements: this.store.requirements(),
			events: this.store.events(),
			checkpoints: this.store.checkpoints(),
			candidates: this.store.candidates(),
			publications: this.store.publications(),
			verifications: this.store.verifications(),
			findings: this.store.findings(),
			reviews: this.store.reviews(),
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
	async modelSmoke(prompt: string): Promise<Record<string, unknown>> {
		await this.lifecycle.start();
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
			requestedModel: this.config.authorModel,
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

	async armFault(boundary: string, attempt?: string): Promise<{ armed: boolean }> {
		if (!faultsEnabled(this.config)) return { armed: false };
		this.store.armFault(boundary, attempt);
		this.store.log("fault.armed", { boundary, attempt });
		return { armed: true };
	}
}
