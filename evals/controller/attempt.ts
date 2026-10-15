// One evaluation attempt: provision → seed → trigger → observe → settle →
// grade → write. State is saved after every stage so an interrupted
// controller resumes the same attempt instead of starting another.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ops } from "./bot.ts";
import { grade } from "./grade.ts";
import { gh, gitAuthEnv, gitUrl } from "./github.ts";
import { ensureRepo, resetRepo, seed, trigger } from "./provision.ts";
import type { AttemptState, CaseManifest, GraderManifest, Outcome, Profile } from "./types.ts";

export const RESULTS = "evals/results";

export function loadCase(id: string): {
	manifest: CaseManifest;
	grader: GraderManifest;
	digest: string;
} {
	const raw = readFileSync(`evals/cases/${id}.json`, "utf8");
	return {
		manifest: JSON.parse(raw) as CaseManifest,
		grader: JSON.parse(readFileSync(`evals/graders/${id}.json`, "utf8")) as GraderManifest,
		digest: createHash("sha256").update(raw).digest("hex"),
	};
}

function dir(attemptId: string): string {
	return join(RESULTS, attemptId);
}

export function save(state: AttemptState): void {
	mkdirSync(dir(state.attemptId), { recursive: true });
	writeFileSync(join(dir(state.attemptId), "state.json"), JSON.stringify(state, null, 2));
}

export function load(attemptId: string): AttemptState {
	return JSON.parse(readFileSync(join(dir(attemptId), "state.json"), "utf8")) as AttemptState;
}

function advance(state: AttemptState, stage: AttemptState["stage"], note?: string): void {
	state.stage = stage;
	state.history.push({ at: Date.now(), stage, ...(note ? { note } : {}) });
	save(state);
	console.log(`[${state.attemptId}] ${stage}${note ? `: ${note}` : ""}`);
}

export function newAttempt(
	caseId: string,
	profile: Profile,
	fault: string | null,
	model: string | null = null,
	childModel: string | null = null,
): AttemptState {
	const state: AttemptState = {
		attemptId: `${caseId}-${fault ?? "none"}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`,
		caseId,
		profile: profile.name,
		fault,
		model,
		childModel,
		stage: "created",
		history: [],
	};
	save(state);
	return state;
}

// The author is done until a human acts: ready, blocked, asking, declined or stopped.
const SETTLED = new Set([
	"ready-for-human",
	"needs-human",
	"waiting-for-reply",
	"declined",
	"cancelled",
	"terminal",
]);

export async function runAttempt(state: AttemptState, profile: Profile): Promise<AttemptState> {
	const { manifest, grader, digest } = loadCase(state.caseId);
	if (state.stage === "created") {
		const repo = await ensureRepo(profile, manifest);
		const snapshot = await resetRepo(profile, manifest, repo.fullName);
		state.repo = repo;
		advance(state, "provisioned", `${repo.fullName} at snapshot ${snapshot.slice(0, 12)}`);
	}
	if (state.stage === "provisioned") {
		const seeded = await seed(profile, manifest, state.repo!.fullName);
		state.issueNumber = seeded.issueNumber;
		state.prNumber = seeded.prNumber;
		state.botCaseId = seeded.prId
			? `${state.repo!.id}-pr-${seeded.prId}`
			: `${state.repo!.id}-issue-${seeded.issueId}`;
		const bot = await ops(profile, "/");
		state.manifest = {
			attemptId: state.attemptId,
			case: manifest.id,
			caseDigest: digest,
			harness: {
				commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
				deployment: bot.version ?? null,
				profile: profile.name,
			},
			lockDigest: createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex"),
			imageDigest: process.env.SANDBOX_IMAGE_DIGEST ?? null,
			requestedModel: state.model ?? manifest.fixtureModel ?? bot.authorModel,
			childModel: state.childModel ?? null,
			promptHash: bot.promptHash,
			skillHash: bot.skillHash,
			budgets: { bot: bot.budgets, case: manifest.budget },
			fault: state.fault,
			concurrency: 1,
			seed: null,
		};
		// Fixture overrides and faults enter through the authenticated operator path before intake.
		const model = state.model ?? manifest.fixtureModel;
		if (model || state.childModel)
			await ops(profile, `/ops/cases/${state.botCaseId}/fixture`, {
				...(model ? { model } : {}),
				...(state.childModel ? { childModel: state.childModel } : {}),
			});
		const faults = [
			...(manifest.faults ?? []),
			...(state.fault && state.fault !== "none" ? [state.fault] : []),
		];
		for (const boundary of faults)
			await ops(profile, `/ops/cases/${state.botCaseId}/faults`, {
				boundary,
				attempt: state.attemptId,
			});
		advance(
			state,
			"seeded",
			`issue #${state.issueNumber}${state.prNumber ? `, PR #${state.prNumber}` : ""}; faults: ${faults.join(", ") || "none"}`,
		);
	}
	if (state.stage === "seeded") {
		await trigger(profile, state.repo!.fullName, state.prNumber ?? state.issueNumber!);
		state.triggeredAt = Date.now();
		state.deadline = state.triggeredAt + manifest.budget.caseMinutes * 60_000;
		advance(state, "triggered", `intake label applied; case ${state.botCaseId}`);
	}
	if (state.stage === "triggered" || state.stage === "observing") {
		if (state.stage === "triggered") advance(state, "observing");
		let last = "";
		for (;;) {
			let status: { status: string; reasons: string[]; publication?: { state: string } };
			try {
				status = await ops(profile, `/ops/cases/${state.botCaseId}/status`);
			} catch (error) {
				status = { status: "unreachable", reasons: [String(error)] };
			}
			if (status.status !== last) {
				console.log(`[${state.attemptId}] status ${status.status}: ${status.reasons.join("; ")}`);
				last = status.status;
			}
			const published = status.publication?.state === "pr-ensured";
			const deliveryDone = manifest.kind === "delivery" && published && status.status !== "working";
			if (SETTLED.has(status.status) || deliveryDone) {
				state.outcome = (
					status.status === "terminal" ? "cancelled" : deliveryDone ? "waiting" : status.status
				) as Outcome;
				break;
			}
			if (Date.now() > state.deadline!) {
				await ops(profile, `/ops/cases/${state.botCaseId}/cancel`, {}).catch(() => undefined);
				state.outcome = "timed-out";
				break;
			}
			await new Promise((r) => setTimeout(r, profile.pollMs));
		}
		state.settledAt = Date.now();
		advance(state, "settled", state.outcome);
	}
	if (state.stage === "settled") {
		const evidence = await ops(profile, `/ops/cases/${state.botCaseId}/evidence`);
		writeFileSync(join(dir(state.attemptId), "evidence.json"), JSON.stringify(evidence, null, 2));
		const head: string | null = evidence.status?.head ?? null;
		let gradeResult = null;
		if (head && grader.commands.length > 0)
			gradeResult = grade(grader, { fullName: state.repo!.fullName, commit: head });
		writeFileSync(join(dir(state.attemptId), "grade.json"), JSON.stringify(gradeResult, null, 2));
		if (head) {
			const base = (
				await gh<{ object: { sha: string } }>(
					"GET",
					`/repos/${state.repo!.fullName}/git/ref/heads/main`,
				)
			).data.object.sha;
			const diff = execFileSync(
				"bash",
				[
					"-c",
					`d=$(mktemp -d) && cd $d && git init -q && git fetch -q --depth=50 ${JSON.stringify(gitUrl(state.repo!.fullName))} ${head} ${base} && git diff ${base} ${head}; rm -rf $d`,
				],
				{ maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...gitAuthEnv() } },
			).toString();
			// Anonymized for blind human review: no model, harness or bot identity.
			writeFileSync(
				join(dir(state.attemptId), "review-queue.diff"),
				diff.replace(/^.*(EmDash-Bot-|emdash-bot|Pi Durable|model\/tool).*$/gim, ""),
			);
			const checks = await gh(
				"GET",
				`/repos/${state.repo!.fullName}/commits/${head}/check-runs?per_page=100`,
			);
			writeFileSync(join(dir(state.attemptId), "ci.json"), JSON.stringify(checks.data, null, 2));
		}
		advance(
			state,
			"graded",
			gradeResult
				? gradeResult.passed
					? "private grader passed"
					: "private grader failed"
				: "no published commit to grade",
		);
	}
	if (state.stage === "graded") {
		writeSummary(state);
		advance(state, "written");
	}
	return state;
}

function writeSummary(state: AttemptState): void {
	const d = dir(state.attemptId);
	const evidence = existsSync(join(d, "evidence.json"))
		? JSON.parse(readFileSync(join(d, "evidence.json"), "utf8"))
		: {};
	const gradeResult = existsSync(join(d, "grade.json"))
		? JSON.parse(readFileSync(join(d, "grade.json"), "utf8"))
		: null;
	const log: Array<{ at: number; type: string; data: Record<string, unknown> }> =
		evidence.log ?? [];
	const at = (type: string) => log.find((e) => e.type === type)?.at ?? null;
	const preparation = log
		.filter((e) => e.type === "sandbox.restored")
		.reduce((sum, e) => sum + Number(e.data.totalMs ?? 0), 0);
	const jobs = (evidence.verifications ?? [])
		.filter((v: any) => v.kind === "sandbox")
		.reduce((sum: number, v: any) => sum + Number(v.details?.durationMs ?? 0), 0);
	const published = at("publication.receipt");
	const summary = {
		attemptId: state.attemptId,
		case: state.caseId,
		fault: state.fault,
		outcome: state.outcome,
		automated: {
			privateGrader: gradeResult ? (gradeResult.passed ? "passed" : "failed") : "not-run",
			graderStatus: gradeResult?.grader ?? null,
			finalStatus: evidence.status?.status ?? null,
			outstandingFindings: evidence.status?.outstandingFindings?.length ?? null,
			candidates: evidence.candidates?.length ?? 0,
			rounds: log.filter((e) => e.type === "round.start").length,
			tokens: evidence.tokens ?? null,
			faultsInjected: log.filter((e) => e.type === "fault.injected").map((e) => e.data.boundary),
			duplicatePublications:
				(evidence.publications ?? []).filter((p: any) => p.state === "pr-ensured").length >
				(evidence.candidates ?? []).length,
		},
		timeMs: {
			total: state.settledAt && state.triggeredAt ? state.settledAt - state.triggeredAt : null,
			toPublication: published && state.triggeredAt ? published - state.triggeredAt : null,
			preparation,
			focusedJobs: jobs,
		},
		// Filled in by human reviewers; not inferred.
		human: { classification: null, repairMinutes: null, notes: null },
		classifications: [
			"accepted-without-repair",
			"accepted-after-repair",
			"correct-handoff",
			"incorrect-or-false-completion",
			"stalled-or-failed",
		],
		manifest: state.manifest,
	};
	writeFileSync(join(d, "summary.json"), JSON.stringify(summary, null, 2));
}
