// Replay the author's pre-submit adversarial self-review on existing pull
// requests: each PR head becomes a private single-commit fixture, and the
// staging author runs a dry run whose task is the review it would delegate
// before submitting. Findings land in evals/results/review-replay/ for
// scoring against an answer key. Nothing is posted anywhere.
//
//   node --experimental-strip-types evals/bin/review-replay.ts <pr>... [--runs 2] [--guidance <file>] [--models a,b]

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ops } from "../controller/bot.ts";
import { ensureRepo, resetRepo, sanitize } from "../controller/provision.ts";
import type { CaseManifest, Profile } from "../controller/types.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		runs: { type: "string", default: "2" },
		// Model refs as the Worker takes them, e.g. cloudflare-ai-gateway:claude-sonnet-5-5; empty for the profile's author model.
		models: { type: "string", default: "" },
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

/** The reviewer's report (its reply bodies, else its last text), with recorded usage and cost. */
function findings(evidence: { transcript?: unknown[] }): { report: string; usage: string } {
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
	return {
		report: replies.join("\n\n---\n\n") || texts.at(-1) || "(no report)",
		usage: `${tokens} tokens, $${cost.toFixed(2)} recorded`,
	};
}

function slug(model: string): string {
	return (model.split(":").pop() || "author").replace(/[^a-z0-9.-]+/gi, "-");
}

async function replay(pr: number, run: number, model: string): Promise<void> {
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
	const outcome = await waitSettled(
		result.caseId,
		started + Number(values["timeout-minutes"]) * 60_000,
	);
	const evidence = (await ops(profile, `/ops/cases/${result.caseId}/evidence`)) as {
		transcript?: unknown[];
	};
	const { report, usage } = findings(evidence);
	const tag = `${pr}-${slug(model)}-run${run}`;
	const file = join(OUT, `${tag}.md`);
	writeFileSync(
		file,
		`# Review replay: PR ${pr}, ${model || "author model"}, run ${run}\n\nCase ${result.caseId}, outcome ${outcome}, ${Math.round((Date.now() - started) / 60_000)} min, ${usage}.\n\n${report}\n`,
	);
	writeFileSync(join(OUT, `${tag}.evidence.json`), JSON.stringify(evidence));
	console.log(`[${tag}] ${outcome}, ${usage}; findings in ${file}`);
}

const prs = positionals.map(Number);
const runs = Number(values.runs);
const models = values.models ? values.models.split(",") : [""];
// PRs in parallel (each has its own fixture repository); runs of one PR in sequence, as they share it.
await Promise.all(
	prs.map(async (pr) => {
		for (const model of models)
			for (let run = 1; run <= runs; run++)
				await replay(pr, run, model).catch((error: unknown) =>
					console.error(
						`[${pr} ${slug(model)}#${run}] failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
	}),
);
