// Provision or reset an isolated fixture repository and seed the task. Only
// bot-owned disposable resources are touched; upstream EmDash issues are
// never referenced by URL from fixture text.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gh, gitAuthEnv, gitUrl } from "./github.ts";
import type { CaseManifest, Profile } from "./types.ts";

const GREETING: Record<string, string> = {
	"README.md":
		"# emdash-bot-pi evaluation fixture\n\nDisposable. Issues and pull requests here are test data.\n",
	"AGENTS.md": "Run `node test.js` before submitting a change.\n",
	"greet.js": 'module.exports = (name) => "Hello " + name;\n',
	"test.js":
		'const greet = require("./greet");\nif (greet("Ada") !== "Hello, Ada!") {\n\tconsole.error("expected greeting with punctuation");\n\tprocess.exit(1);\n}\nconsole.log("ok");\n',
	".github/workflows/test.yml":
		'name: test\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - uses: actions/setup-node@v5\n        with:\n          node-version: "24"\n      - run: node test.js\n',
};

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, {
		cwd,
		input,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			GIT_AUTHOR_NAME: "eval-controller",
			GIT_AUTHOR_EMAIL: "eval@example.invalid",
			GIT_COMMITTER_NAME: "eval-controller",
			GIT_COMMITTER_EMAIL: "eval@example.invalid",
			GIT_TERMINAL_PROMPT: "0",
			...gitAuthEnv(),
		},
		maxBuffer: 256 * 1024 * 1024,
	})
		.toString()
		.trim();
}

/** Replace upstream issue and PR URLs so fixture text never cross-references them. */
export function sanitize(text: string): string {
	return text
		.replace(/https:\/\/github\.com\/emdash-cms\/emdash\/(issues|pull)\/(\d+)/g, "upstream $1 $2")
		.replace(/\bemdash-cms\/emdash#(\d+)/g, "upstream #$1");
}

export function repoName(profile: Profile, manifest: CaseManifest): string {
	return `${profile.owner}/${profile.repoPrefix}${manifest.id}`;
}

export async function ensureRepo(
	profile: Profile,
	manifest: CaseManifest,
): Promise<{ fullName: string; id: number }> {
	const fullName = repoName(profile, manifest);
	if (fullName === "emdash-cms/emdash")
		throw new Error("refusing to use the production repository as a fixture");
	const existing = await gh<{ id: number; private: boolean }>(
		"GET",
		`/repos/${fullName}`,
		undefined,
		[404],
	);
	if (existing.status === 200) {
		if (!existing.data.private) throw new Error(`${fullName} is public; fixtures must be private`);
		return { fullName, id: existing.data.id };
	}
	const created = await gh<{ id: number }>("POST", `/orgs/${profile.owner}/repos`, {
		name: fullName.split("/")[1],
		private: true,
		description: `Disposable emdash-bot-pi evaluation fixture for case ${manifest.id}`,
		has_wiki: false,
		auto_init: false,
	});
	await gh(
		"POST",
		`/repos/${fullName}/labels`,
		{ name: profile.intakeLabel, color: "5319e7" },
		[422],
	);
	return { fullName, id: created.data.id };
}

/** Reset the fixture to a single-commit snapshot of the starting source and clear earlier attempts. */
export async function resetRepo(
	profile: Profile,
	manifest: CaseManifest,
	fullName: string,
): Promise<string> {
	for (const state of ["issues", "pulls"] as const) {
		const open = await gh<Array<{ number: number }>>(
			"GET",
			`/repos/${fullName}/${state}?state=open&per_page=100`,
		);
		for (const item of open.data)
			await gh("PATCH", `/repos/${fullName}/${state}/${item.number}`, { state: "closed" });
	}
	const refs = await gh<Array<{ ref: string }>>(
		"GET",
		`/repos/${fullName}/git/matching-refs/heads/`,
		undefined,
		[404, 409],
	);
	for (const ref of Array.isArray(refs.data) ? refs.data : []) {
		if (ref.ref !== "refs/heads/main")
			await gh("DELETE", `/repos/${fullName}/git/${ref.ref}`, undefined, [422]);
	}
	const work = mkdtempSync(join(tmpdir(), "eval-fixture-"));
	try {
		git(work, ["init", "-q", "-b", "main"]);
		let tree: string;
		if (manifest.source.template === "greeting") {
			for (const [path, content] of Object.entries(GREETING)) {
				mkdirSync(dirname(join(work, path)), { recursive: true });
				writeFileSync(join(work, path), content);
			}
			git(work, ["add", "-A"]);
			tree = git(work, ["write-tree"]);
		} else {
			const start = manifest.source.startingCommit!;
			git(work, [
				"fetch",
				"-q",
				"--depth=1",
				"--no-tags",
				`https://github.com/${manifest.source.repo}.git`,
				start,
			]);
			tree = git(work, ["rev-parse", `${start}^{tree}`]);
		}
		const snapshot = git(work, [
			"commit-tree",
			tree,
			"-m",
			`fixture snapshot for case ${manifest.id}${manifest.source.startingCommit ? ` (tree of ${manifest.source.startingCommit})` : ""}`,
		]);
		git(work, ["push", "-q", "--force", gitUrl(fullName), `${snapshot}:refs/heads/main`]);
		if (manifest.originalCandidate) {
			const candidate = manifest.originalCandidate;
			git(work, [
				"fetch",
				"-q",
				"--depth=1",
				"--no-tags",
				`https://github.com/${manifest.source.repo}.git`,
				candidate.commit,
			]);
			const candidateTree = git(work, ["rev-parse", `${candidate.commit}^{tree}`]);
			const commit = git(work, [
				"commit-tree",
				candidateTree,
				"-p",
				snapshot,
				"-m",
				"original candidate (historical, incomplete)",
			]);
			git(work, [
				"push",
				"-q",
				"--force",
				gitUrl(fullName),
				`${commit}:refs/heads/fixture/original-candidate`,
			]);
		}
		return snapshot;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

export interface Seeded {
	readonly issueNumber: number;
	readonly issueId: number;
	readonly prNumber?: number;
	readonly prId?: number;
}

export async function seed(
	profile: Profile,
	manifest: CaseManifest,
	fullName: string,
): Promise<Seeded> {
	const script = manifest.script
		? `\n\n\`\`\`scripted-author\n${JSON.stringify(manifest.script)}\n\`\`\`\n`
		: "";
	const body = `${sanitize(manifest.issue.body)}${script}\n\n<sub>Evaluation fixture for case ${manifest.id}.</sub>`;
	const issue = await gh<{ number: number; id: number }>("POST", `/repos/${fullName}/issues`, {
		title: manifest.issue.title,
		body,
	});
	if (!manifest.originalCandidate)
		return { issueNumber: issue.data.number, issueId: issue.data.id };
	const pr = await gh<{ number: number; id: number; head: { sha: string } }>(
		"POST",
		`/repos/${fullName}/pulls`,
		{
			title: sanitize(manifest.issue.title),
			head: "fixture/original-candidate",
			base: "main",
			body: `Closes #${issue.data.number}\n\nHistorical candidate seeded for case ${manifest.id}.`,
		},
	);
	for (const review of manifest.originalCandidate.reviews) {
		await gh("POST", `/repos/${fullName}/pulls/${pr.data.number}/reviews`, {
			commit_id: pr.data.head.sha,
			event: "COMMENT",
			body: sanitize(review.body),
		});
	}
	return {
		issueNumber: issue.data.number,
		issueId: issue.data.id,
		prNumber: pr.data.number,
		prId: pr.data.id,
	};
}

export async function trigger(profile: Profile, fullName: string, number: number): Promise<void> {
	await gh("POST", `/repos/${fullName}/issues/${number}/labels`, { labels: [profile.intakeLabel] });
}
