// Replay the author's pre-submit review on existing pull requests. Nothing is
// posted anywhere; findings land in evals/results/review-replay/ for scoring
// against the answer key.
//
// --mode tool (default): the fixture starts at the pull request's merge base
// with its change applied as uncommitted work, and the staging author calls
// the review tool exactly as it would before submitting; --models picks the
// review model.
// --mode prompt: the earlier replay, a dry run at the PR head whose task is a
// hand-written review; --models picks the author model doing the review.
//
//   node --experimental-strip-types evals/bin/review-replay.ts <pr>... [--runs 1] [--models a,b] [--mode tool|prompt]

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ops } from "../controller/bot.ts";
import { gh as githubApi } from "../controller/github.ts";
import { ensureRepo, resetRepo, sanitize } from "../controller/provision.ts";
import type { CaseManifest, Profile } from "../controller/types.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		runs: { type: "string", default: "1" },
		// Number of the first run, so a later repeat does not overwrite earlier results.
		"first-run": { type: "string", default: "1" },
		// Model refs as the Worker takes them, e.g. cloudflare-ai-gateway:claude-sonnet-5-5; empty for the profile's author model.
		models: { type: "string", default: "" },
		mode: { type: "string", default: "tool" },
		guidance: { type: "string" },
		profile: { type: "string", default: "pi-staging" },
		"timeout-minutes": { type: "string", default: "60" },
	},
});

const profile = JSON.parse(
	readFileSync(`evals/profiles/${values.profile}.json`, "utf8"),
) as Profile;
const production = JSON.parse(readFileSync("profiles/production.json", "utf8")) as {
	repositories: Array<{ prepare?: string; focusedChecks?: Record<string, string> }>;
};
const upstream = production.repositories[0]!;
const OUT = "evals/results/review-replay";
mkdirSync(OUT, { recursive: true });

function gh(args: string[]): string {
	return execFileSync("gh", args, { maxBuffer: 64 * 1024 * 1024 }).toString();
}

const guidance = values.guidance
	? readFileSync(values.guidance, "utf8")
	: "Follow the repository's adversarial review skill in skills/adversarial-reviewer/SKILL.md.";

function brief(pr: number): { title: string; body: string } {
	const meta = JSON.parse(
		gh([
			"pr",
			"view",
			String(pr),
			"-R",
			"emdash-cms/emdash",
			"--json",
			"title,body,closingIssuesReferences",
		]),
	) as { title: string; body: string; closingIssuesReferences: Array<{ number: number }> };
	const issueNumber = meta.closingIssuesReferences[0]?.number;
	const issue = issueNumber
		? (JSON.parse(
				gh([
					"issue",
					"view",
					String(issueNumber),
					"-R",
					"emdash-cms/emdash",
					"--json",
					"title,body",
				]),
			) as { title: string; body: string })
		: { title: "(no linked issue)", body: "" };
	const diff = gh(["pr", "diff", String(pr), "-R", "emdash-cms/emdash"]);
	const body = [
		"This is a review task, not an implementation task. Do not change any files and do not submit a candidate.",
		"",
		"You wrote the change below to fix the issue below, and you are about to submit it. Before you do, review it adversarially, as a demanding maintainer would: does it fix what was reported in the reporter's situation, and is every claim in its description true? The checkout is at the change's head, so read the surrounding code, and run focused checks if that is the fastest way to settle a claim.",
		"",
		"## Review guidance",
		"",
		guidance.trim(),
		"",
		`## The issue: ${issue.title}`,
		"",
		sanitize(issue.body).slice(0, 20_000),
		"",
		`## The change: ${meta.title}`,
		"",
		"### Description",
		"",
		sanitize(meta.body).slice(0, 20_000),
		"",
		"### Diff",
		"",
		"```diff",
		diff.slice(0, 80_000),
		"```",
		"",
		"## Report",
		"",
		'When you are done, post your complete findings with the reply tool (it is recorded, not published): most severe first, each with the file and line, the failing scenario, and the fix direction. Say plainly if you found nothing significant. Then call handoff with reason "review complete" and nextAction "none".',
	].join("\n");
	return { title: `Review: ${meta.title}`, body };
}

async function waitSettled(caseId: string, deadline: number): Promise<string> {
	for (;;) {
		const status = (await ops(profile, `/ops/cases/${caseId}/status`).catch(() => null)) as {
			status: string;
		} | null;
		if (
			status &&
			[
				"needs-human",
				"waiting-for-reply",
				"candidate-published",
				"declined",
				"cancelled",
				"terminal",
			].includes(status.status)
		)
			return status.status;
		if (Date.now() > deadline) return "timed-out";
		await new Promise((r) => setTimeout(r, profile.pollMs));
	}
}

interface PullRequest {
	title: string;
	body: string;
	headRefOid: string;
	baseRefOid: string;
}

function pullRequest(pr: number): PullRequest {
	return JSON.parse(
		gh([
			"pr",
			"view",
			String(pr),
			"-R",
			"emdash-cms/emdash",
			"--json",
			"title,body,headRefOid,baseRefOid",
		]),
	) as PullRequest;
}

/** The task for the tool replay: call review with the pull request's own text, and relay the result. */
function toolBrief(meta: PullRequest): { title: string; body: string } {
	return {
		title: `Review: ${meta.title}`,
		body: [
			"This is a review task, not an implementation task. The checkout already holds a finished change as uncommitted work. Do not change any files and do not submit a candidate.",
			"",
			'Call the review tool once, with exactly the title and description below. Then post the review tool\'s complete result, unedited, with the reply tool (it is recorded, not published), and call handoff with reason "review complete" and nextAction "none".',
			"",
			"## Title",
			"",
			sanitize(meta.title),
			"",
			"## Description",
			"",
			sanitize(meta.body).slice(0, 20_000),
		].join("\n"),
	};
}

/** The reviewer's report (its reply bodies, else its last text), with recorded usage and cost. */
function findings(evidence: {
	transcript?: unknown[];
	usageByModel?: Record<string, { tokens: number; cost: number }>;
}): { report: string; usage: string } {
	const replies: string[] = [];
	const texts: string[] = [];
	let cost = 0;
	let tokens = 0;
	for (const entry of (evidence.transcript ?? []) as Array<{
		model?: Array<Record<string, unknown>>;
	}>)
		for (const m of entry.model ?? []) {
			if (m.role !== "assistant") continue;
			const usage = m.usage as { totalTokens?: number; cost?: { total?: number } } | undefined;
			cost += usage?.cost?.total ?? 0;
			tokens += usage?.totalTokens ?? 0;
			for (const part of (m.content as Array<{
				type: string;
				text?: string;
				name?: string;
				arguments?: { body?: string };
			}>) ?? []) {
				if (part.type === "text" && part.text?.trim()) texts.push(part.text.trim());
				if (part.type === "toolCall" && part.name === "reply" && part.arguments?.body)
					replies.push(part.arguments.body);
			}
		}
	const byModel = Object.entries(evidence.usageByModel ?? {});
	return {
		report: replies.join("\n\n---\n\n") || texts.at(-1) || "(no report)",
		usage: byModel.length
			? byModel
					.map(
						([model, u]) =>
							`${model}: ${(u.tokens / 1e6).toFixed(2)}M tokens, $${u.cost.toFixed(2)}`,
					)
					.join("; ")
			: `${tokens} tokens, $${cost.toFixed(2)} recorded`,
	};
}

function slug(model: string): string {
	return (model.split(":").pop() || "author").replace(/[^a-z0-9.-]+/gi, "-");
}

/** A fixture at the pull request's merge base, with its head tree as a child commit to apply as work. */
async function toolFixture(
	pr: number,
	meta: PullRequest,
): Promise<{ repo: { fullName: string; id: number }; snapshot: string; working: string }> {
	const mergeBase = (
		await githubApi<{ merge_base_commit: { sha: string } }>(
			"GET",
			`/repos/emdash-cms/emdash/compare/${meta.baseRefOid}...${meta.headRefOid}`,
		)
	).data.merge_base_commit.sha;
	const manifest = {
		id: `review-${pr}`,
		kind: "fix",
		source: { repo: "emdash-cms/emdash", startingCommit: mergeBase },
		originalCandidate: { commit: meta.headRefOid, parent: mergeBase, reviews: [] },
	} as unknown as CaseManifest;
	const repo = await ensureRepo(profile, manifest);
	const snapshot = await resetRepo(profile, manifest, repo.fullName);
	const working = (
		await githubApi<{ object: { sha: string } }>(
			"GET",
			`/repos/${repo.fullName}/git/ref/heads/fixture/original-candidate`,
		)
	).data.object.sha;
	return { repo, snapshot, working };
}

async function replayTool(pr: number, run: number, model: string): Promise<void> {
	const meta = pullRequest(pr);
	const { repo, snapshot, working } = await toolFixture(pr, meta);
	const { title, body } = toolBrief(meta);
	const started = Date.now();
	const result = (await ops(profile, "/ops/dry-run", {
		repo: repo.fullName,
		repoId: repo.id,
		issueNumber: pr,
		title,
		body,
		baseCommit: snapshot,
		workingCommit: working,
		prepare: upstream.prepare,
		focusedChecks: upstream.focusedChecks,
		...(model ? { reviewModel: model } : {}),
	})) as { caseId: string };
	console.log(`[${pr}#${run}] tool replay ${result.caseId} on ${repo.fullName}`);
	await record(pr, run, model, "tool", result.caseId, started);
}

async function record(
	pr: number,
	run: number,
	model: string,
	mode: string,
	caseId: string,
	started: number,
): Promise<void> {
	const outcome = await waitSettled(caseId, started + Number(values["timeout-minutes"]) * 60_000);
	const evidence = (await ops(profile, `/ops/cases/${caseId}/evidence`)) as {
		transcript?: unknown[];
		usageByModel?: Record<string, { tokens: number; cost: number }>;
	};
	const { report, usage } = findings(evidence);
	const tag = `${pr}-${mode === "tool" ? "tool-" : ""}${slug(model)}-run${run}`;
	const file = join(OUT, `${tag}.md`);
	writeFileSync(
		file,
		`# Review replay (${mode}): PR ${pr}, ${model || "default model"}, run ${run}\n\nCase ${caseId}, outcome ${outcome}, ${Math.round((Date.now() - started) / 60_000)} min, ${usage}.\n\n${report}\n`,
	);
	writeFileSync(join(OUT, `${tag}.evidence.json`), JSON.stringify(evidence));
	console.log(`[${tag}] ${outcome}, ${usage}; findings in ${file}`);
}

async function replay(pr: number, run: number, model: string): Promise<void> {
	if (values.mode === "tool") return replayTool(pr, run, model);
	const head = gh([
		"pr",
		"view",
		String(pr),
		"-R",
		"emdash-cms/emdash",
		"--json",
		"headRefOid",
		"-q",
		".headRefOid",
	]).trim();
	const manifest = {
		id: `review-${pr}`,
		kind: "fix",
		source: { repo: "emdash-cms/emdash", startingCommit: head },
	} as unknown as CaseManifest;
	const repo = await ensureRepo(profile, manifest);
	const snapshot = await resetRepo(profile, manifest, repo.fullName);
	const { title, body } = brief(pr);
	const started = Date.now();
	const result = (await ops(profile, "/ops/dry-run", {
		repo: repo.fullName,
		repoId: repo.id,
		issueNumber: pr,
		title,
		body,
		baseCommit: snapshot,
		prepare: upstream.prepare,
		focusedChecks: upstream.focusedChecks,
		...(model ? { model } : {}),
	})) as { caseId: string };
	console.log(
		`[${pr}#${run}] dry run ${result.caseId} on ${repo.fullName} at ${snapshot.slice(0, 12)}`,
	);
	await record(pr, run, model, "prompt", result.caseId, started);
}

const prs = positionals.map(Number);
const runs = Number(values.runs);
const firstRun = Number(values["first-run"]);
const models = values.models ? values.models.split(",") : [""];
// PRs in parallel (each has its own fixture repository); runs of one PR in sequence, as they share it.
await Promise.all(
	prs.map(async (pr) => {
		for (const model of models)
			for (let run = firstRun; run < firstRun + runs; run++)
				await replay(pr, run, model).catch((error: unknown) =>
					console.error(
						`[${pr} ${slug(model)}#${run}] failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
	}),
);
