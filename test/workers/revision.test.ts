// Slice 4: review findings drive repair, checks are classified on the exact
// head, readiness needs current-head evidence, and the branch is never
// force-pushed.

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Bot,
	BOT,
	FIX_GREETING,
	REPO,
	REPO_ID,
	REVIEWER,
	assignIssue,
	authorRuns,
	fixScript,
	issueCaseId,
	startBot,
} from "../harness.ts";

let bot: Bot | undefined;
afterEach(async () => {
	await bot?.dispose();
	bot = undefined;
});

const REVISED = {
	path: "greet.js",
	content: 'module.exports = (name = "friend") => "Hello, " + name + "!";\n',
};

const twoRoundScript = {
	rounds: [
		{
			steps: [
				{ tool: "write", args: FIX_GREETING },
				{
					tool: "submit_candidate",
					args: { title: "fix: punctuate the greeting", summary: "Punctuation." },
				},
			],
		},
		{
			steps: [
				{ tool: "write", args: REVISED },
				{ tool: "reply", args: { body: "Added a default name." } },
				{
					tool: "submit_candidate",
					args: {
						title: "fix: punctuate the greeting",
						summary: "Punctuation and a default name.",
					},
				},
			],
		},
	],
};

function review(
	number: number,
	commit: string,
	block: unknown,
	state = "COMMENTED",
	id = Math.floor(Math.random() * 1e9),
) {
	return {
		action: "submitted",
		sender: { login: REVIEWER },
		pull_request: { id: 9000 + number, number },
		review: {
			id,
			user: { login: REVIEWER },
			commit_id: commit,
			state,
			body: `Looks mostly fine.\n\n\`\`\`emdash-review-findings\n${JSON.stringify(block)}\n\`\`\`\n`,
		},
	};
}

function checkRun(
	bot: Bot,
	number: number,
	branch: string,
	sha: string,
	name: string,
	conclusion: string,
	summary = "",
	id = Math.floor(Math.random() * 1e9),
) {
	bot.github.checkRuns.push({
		id,
		name,
		head_sha: sha,
		status: "completed",
		conclusion,
		output: { title: null, summary, text: null },
	});
	return bot.webhook("check_run", {
		action: "completed",
		sender: { login: "github-actions[bot]" },
		check_run: {
			id,
			name,
			head_sha: sha,
			status: "completed",
			conclusion,
			output: { title: "", summary, text: "" },
			app: { slug: "github-actions" },
			check_suite: { head_branch: branch },
			pull_requests: [{ number }],
		},
	});
}

async function publishedCount(bot: Bot, caseId: string, count: number) {
	return bot.waitFor(`${count} publication(s)`, async () => {
		const r = await bot.inspect(caseId);
		return r.publications.filter((p: any) => p.state === "pr-ensured").length >= count ? r : null;
	});
}

async function statusIs(bot: Bot, caseId: string, status: string) {
	return bot.waitFor(`status ${status}`, async () => {
		const s = await bot.ops(`cases/${caseId}/status`);
		return s.status === status ? s : null;
	});
}

describe("review repair and asynchronous CI", () => {
	it("repairs a COMMENTED review with green CI and reaches readiness only on reviewed, checked head", async () => {
		bot = await startBot();
		const caseId = issueCaseId(31);
		const branch = "emdash-bot/issue-31";
		await bot.webhook("issues", assignIssue({ issueId: 31, number: 31, script: twoRoundScript }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head1 = bot.github.head(REPO, branch)!;
		await checkRun(bot, pr, branch, head1, "test", "success");
		await statusIs(bot, caseId, "candidate-published");

		await bot.webhook(
			"pull_request_review",
			review(pr, head1, {
				version: 1,
				reviewedCommit: head1,
				findings: [
					{
						id: "F1",
						severity: "major",
						path: "greet.js",
						line: 1,
						title: "Missing default",
						body: "Handle a missing name.",
					},
				],
			}),
		);
		const second = await publishedCount(bot, caseId, 2);
		const head2 = bot.github.head(REPO, branch)!;
		expect(head2).not.toBe(head1);
		expect(bot.github.git(REPO, ["rev-parse", `${head2}^`])).toBe(head1); // fast-forward, no force push
		expect(second.reviews[0]).toMatchObject({ structured: true, actionable: 1, commit: head1 });

		// The green check on the old head does not validate the new commit.
		const waiting = await statusIs(bot, caseId, "waiting-for-checks");
		expect(waiting.requiredChecks[0].state).toBe("missing");

		await checkRun(bot, pr, branch, head2, "test", "success");
		await statusIs(bot, caseId, "candidate-published"); // the new head has no review yet
		await bot.webhook(
			"pull_request_review",
			review(
				pr,
				head2,
				{
					version: 1,
					reviewedCommit: head2,
					findings: [],
					dispositions: [{ id: "F1", status: "resolved" }],
				},
				"APPROVED",
			),
		);
		await bot.ops(`cases/${caseId}/resume`, { body: {} });
		const ready = await statusIs(bot, caseId, "ready-for-human");
		expect(ready.humanApproval).toBe("required");
		const record = await bot.inspect(caseId);
		expect(record.reviews.at(-1)).toMatchObject({ commit: head2, state: "APPROVED" });
		// Assignment, the COMMENTED review and the approval each reached the author.
		expect(authorRuns(record)).toHaveLength(3);
		// The bot's own check run tracks the status on each head and never reaches the author.
		const check = await bot.waitFor("status check succeeds", async () =>
			bot!.github.statusChecks.find(
				(c) => c.head_sha === head2 && c.status === "completed" && c.conclusion === "success",
			),
		);
		expect(check).toMatchObject({
			name: "EmDash bot",
			output: { title: "Ready for human review" },
		});
		expect(
			bot.github.statusChecks
				.filter((c) => c.head_sha === head1)
				.every((c) => c.status === "completed" && c.conclusion === "neutral"),
		).toBe(true);
	});

	it("does not request code repair for administrative, infrastructure, stale or skipped checks", async () => {
		bot = await startBot();
		const caseId = issueCaseId(32);
		const branch = "emdash-bot/issue-32";
		await bot.webhook("issues", assignIssue({ issueId: 32, number: 32, script: twoRoundScript }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head = bot.github.head(REPO, branch)!;
		await checkRun(
			bot,
			pr,
			branch,
			head,
			"PR Maintenance",
			"failure",
			"GitHub API returned 502 Bad Gateway",
		);
		await checkRun(
			bot,
			pr,
			branch,
			head,
			"test",
			"failure",
			"Error: HTTP 502 Bad Gateway while downloading dependencies",
		);
		await checkRun(bot, pr, branch, bot.baseCommit, "test", "failure", "assertion failed");
		// A workflow skipped on this head is evidence only, never a message to the author.
		await checkRun(bot, pr, branch, head, "Build", "skipped", "");
		const status = await statusIs(bot, caseId, "needs-human");
		expect(status.reasons.join(" ")).toContain("infrastructure");
		const record = await bot.inspect(caseId);
		const classes = record.verifications
			.filter((v: any) => v.kind === "workflow")
			.map((v: any) => v.classification);
		expect(classes).toEqual(expect.arrayContaining(["administrative", "infrastructure", "stale"]));
		// Past the check settle period: nothing was batched up for the author.
		await new Promise((r) => setTimeout(r, 1500));
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		expect(JSON.stringify(evidence.transcript)).not.toContain("## Checks failed");
		expect(authorRuns(record)).toHaveLength(1);
		expect(record.candidates).toHaveLength(1);
	});

	it("reaches readiness on an approved head when the repository requires no checks", async () => {
		bot = await startBot({
			repositories: [{ id: REPO_ID, fullName: REPO, requiredChecks: [] }],
		});
		const caseId = issueCaseId(36);
		await bot.webhook("issues", assignIssue({ issueId: 36, number: 36, script: fixScript() }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head = bot.github.head(REPO, "emdash-bot/issue-36")!;
		await bot.webhook(
			"pull_request_review",
			review(pr, head, { version: 1, reviewedCommit: head, findings: [] }, "APPROVED"),
		);
		const ready = await statusIs(bot, caseId, "ready-for-human");
		expect(ready.requiredChecks).toEqual([]);
	});

	it("labels the issue and PR awaiting the reporter when ready, with area labels from changed paths", async () => {
		bot = await startBot({
			repositories: [
				{
					id: REPO_ID,
					fullName: REPO,
					requiredChecks: [],
					areaLabels: { "greet.js": "area/core" },
				},
			],
		});
		const caseId = issueCaseId(38);
		await bot.webhook("issues", assignIssue({ issueId: 38, number: 38, script: fixScript() }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head = bot.github.head(REPO, "emdash-bot/issue-38")!;
		await bot.webhook(
			"pull_request_review",
			review(pr, head, { version: 1, reviewedCommit: head, findings: [] }, "APPROVED"),
		);
		await statusIs(bot, caseId, "ready-for-human");
		await bot.waitFor("labels", async () => {
			const issue = bot!.github.labels.get(38);
			const pull = bot!.github.labels.get(pr);
			return (
				issue?.has("triage/awaiting-reporter") &&
				pull?.has("triage/awaiting-reporter") &&
				pull.has("area/core")
			);
		});
	});

	it("ignores a commented review that asks for nothing, keeping the approval and the author asleep", async () => {
		bot = await startBot({
			repositories: [{ id: REPO_ID, fullName: REPO, requiredChecks: [] }],
		});
		const caseId = issueCaseId(37);
		await bot.webhook("issues", assignIssue({ issueId: 37, number: 37, script: fixScript() }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head = bot.github.head(REPO, "emdash-bot/issue-37")!;
		await bot.webhook(
			"pull_request_review",
			review(pr, head, { version: 1, reviewedCommit: head, findings: [] }, "APPROVED"),
		);
		await statusIs(bot, caseId, "ready-for-human");
		const before = authorRuns(await bot.inspect(caseId)).length;
		await bot.webhook("pull_request_review", {
			action: "submitted",
			sender: { login: REVIEWER },
			pull_request: { id: 9000 + pr, number: pr },
			review: {
				id: 3737,
				user: { login: REVIEWER },
				commit_id: head,
				state: "COMMENTED",
				body: "Looks good, no further changes needed.",
			},
		});
		await bot.waitFor("review ignored", async () => {
			const r = await bot!.inspect(caseId);
			return r.log.some((e: any) => e.type === "review.nothing-asked") ? r : null;
		});
		await new Promise((r) => setTimeout(r, 1000));
		const status = await bot.ops(`cases/${caseId}/status`);
		expect(status.status).toBe("ready-for-human");
		expect(status.review.state).toBe("APPROVED");
		expect(authorRuns(await bot.inspect(caseId))).toHaveLength(before);
	});

	it("lists failing check run ids, and the author reads a job log with ci_log", async () => {
		bot = await startBot();
		const caseId = issueCaseId(35);
		const branch = "emdash-bot/issue-35";
		const script = {
			rounds: [
				twoRoundScript.rounds[0],
				{
					steps: [
						{ tool: "ci_log", args: { checkRunId: 4242, lines: 20 } },
						{ tool: "write", args: REVISED },
						{ tool: "submit_candidate", args: { title: "fix: greeting", summary: "Repair." } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 35, number: 35, script }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head = bot.github.head(REPO, branch)!;
		const noise = Array.from({ length: 40 }, (_, i) => `install step ${i}`);
		bot.github.jobLogs.set(
			4242,
			[...noise, "FAIL test.js", "AssertionError: expected greeting"].join("\n"),
		);
		await checkRun(bot, pr, branch, head, "Backend Tests", "failure", "", 4242);
		await publishedCount(bot, caseId, 2);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		const transcript = JSON.stringify(evidence.transcript);
		expect(transcript).toContain("Check run: 4242");
		// CI conclusions belong in the plan; a reply only when a maintainer must act.
		expect(transcript).toContain("Record your conclusion in the work plan");
		expect(transcript).toContain("only when a maintainer has to act");
		const logResult = evidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.find((m: any) => m.role === "toolResult" && m.toolName === "ci_log");
		expect(JSON.stringify(logResult.content)).toContain("AssertionError: expected greeting");
		expect(JSON.stringify(logResult.content)).toContain("[last 20 of 42 lines]");
		expect(JSON.stringify(logResult.content)).not.toContain("install step 0\\n");
	});

	it("sends code failures on the current head to the author, which repairs them", async () => {
		bot = await startBot();
		const caseId = issueCaseId(33);
		const branch = "emdash-bot/issue-33";
		const script = {
			rounds: [
				twoRoundScript.rounds[0],
				{
					steps: [
						{ tool: "write", args: REVISED },
						{ tool: "submit_candidate", args: { title: "fix: greeting", summary: "Repair." } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 33, number: 33, script }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head = bot.github.head(REPO, branch)!;
		await checkRun(bot, pr, branch, head, "test", "failure", "AssertionError: expected greeting");
		await checkRun(bot, pr, branch, head, "test", "failure", "AssertionError: expected greeting");
		await publishedCount(bot, caseId, 2);
		const record = await bot.inspect(caseId);
		// Both failures reached the author as one message; it repaired once.
		expect(authorRuns(record)).toHaveLength(2);
	});

	it("preserves a maintainer commit that lands before the revision is published", async () => {
		bot = await startBot();
		const caseId = issueCaseId(34);
		const branch = "emdash-bot/issue-34";
		await bot.webhook("issues", assignIssue({ issueId: 34, number: 34, script: twoRoundScript }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head1 = bot.github.head(REPO, branch)!;
		const maintainer = bot.github.commitFiles(
			REPO,
			branch,
			{ "README.md": "# widgets\n\nMaintainer note.\n" },
			"docs: maintainer note",
		);
		await bot.webhook(
			"pull_request_review",
			review(pr, head1, {
				version: 1,
				reviewedCommit: head1,
				findings: [
					{ id: "F1", severity: "major", title: "Missing default", body: "Handle a missing name." },
				],
			}),
		);
		const record = await publishedCount(bot, caseId, 2);
		const head = bot.github.head(REPO, branch)!;
		bot.github.git(REPO, ["merge-base", "--is-ancestor", maintainer, head]);
		expect(bot.github.show(REPO, head, "README.md")).toContain("Maintainer note.");
		expect(bot.github.show(REPO, head, "greet.js")).toBe(REVISED.content.trimEnd());
		const integrated = record.candidates.at(-1);
		expect(integrated.origin).toBe("integration");
		expect(integrated.sourceBaseCommit).toBe(maintainer);
		expect(record.log.some((e: any) => e.type === "candidate.integrated")).toBe(true);
	});

	it("hands off when a maintainer commit conflicts with the revision", async () => {
		bot = await startBot();
		const caseId = issueCaseId(35);
		const branch = "emdash-bot/issue-35";
		await bot.webhook("issues", assignIssue({ issueId: 35, number: 35, script: twoRoundScript }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head1 = bot.github.head(REPO, branch)!;
		const maintainer = bot.github.commitFiles(
			REPO,
			branch,
			{ "greet.js": "module.exports = (n) => `Hi, ${n}!`;\n" },
			"fix: maintainer rewrite",
		);
		await bot.webhook(
			"pull_request_review",
			review(pr, head1, {
				version: 1,
				reviewedCommit: head1,
				findings: [{ id: "F1", severity: "major", title: "Missing default", body: "x" }],
			}),
		);
		const status = await statusIs(bot, caseId, "needs-human");
		expect(status.reasons.join(" ")).toContain("does not apply cleanly");
		expect(bot.github.head(REPO, branch)).toBe(maintainer);
	});

	it("inspects an existing check run when its callback was lost", async () => {
		bot = await startBot();
		const caseId = issueCaseId(36);
		const branch = "emdash-bot/issue-36";
		await bot.webhook("issues", assignIssue({ issueId: 36, number: 36, script: twoRoundScript }));
		await publishedCount(bot, caseId, 1);
		const head = bot.github.head(REPO, branch)!;
		bot.github.checkRuns.push({
			id: 777,
			name: "test",
			head_sha: head,
			status: "completed",
			conclusion: "success",
			output: { title: null, summary: null, text: null },
		});
		await bot.ops(`cases/${caseId}/resume`, { body: {} });
		const record = await bot.waitFor("reconciled check", async () => {
			const r = await bot!.inspect(caseId);
			return r.verifications.some((v: any) => v.id === "check:777") ? r : null;
		});
		expect(record.verifications.filter((v: any) => v.id === "check:777")).toHaveLength(1);
		expect(record.log.some((e: any) => e.type === "check.reconciled")).toBe(true);
	});

	it("reports accurately when cancellation lands after a commit was created", async () => {
		bot = await startBot();
		const caseId = issueCaseId(37);
		const branch = "emdash-bot/issue-37";
		await bot.ops(`cases/${caseId}/faults`, { body: { boundary: "after-commit-created" } });
		await bot.webhook("issues", assignIssue({ issueId: 37, number: 37, script: twoRoundScript }));
		await bot.waitFor("fault", async () =>
			(await bot!.inspect(caseId)).log.some((e: any) => e.type === "fault.injected"),
		);
		await bot.webhook("issues", {
			action: "unassigned",
			sender: { login: "maintainer" },
			assignee: { login: BOT },
			issue: { id: 37, number: 37 },
		});
		await new Promise((r) => setTimeout(r, 3000));
		const record = await bot.inspect(caseId);
		expect(record.state).toBe("cancelled");
		const receipt = record.publications.at(-1);
		const head = bot.github.head(REPO, branch);
		if (head === null) expect(["superseded", "commit-created"]).toContain(receipt.state);
		else expect(receipt.commitSha).toBe(head);
		if (receipt.state !== "pr-ensured") expect(bot.github.pulls).toHaveLength(0);
	});
});

describe("adopted pull request revision", () => {
	it("adopts a PR, reads the reviewer's existing review and repairs it on the same branch", async () => {
		bot = await startBot();
		const branch = "fix/greeting";
		bot.github.git(REPO, ["update-ref", `refs/heads/${branch}`, bot.baseCommit]);
		const candidate = bot.github.commitFiles(
			REPO,
			branch,
			{ "greet.js": FIX_GREETING.content },
			"fix: punctuation (incomplete)",
		);
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "write", args: REVISED },
						{ tool: "reply", args: { body: "Default added." } },
						{
							tool: "submit_candidate",
							args: { title: "fix: greeting", summary: "Adds the default name." },
						},
					],
				},
			],
		};
		const pull = bot.github.openPull(
			branch,
			"fix: greeting",
			`Original change.\n\n\`\`\`scripted-author\n${JSON.stringify(script)}\n\`\`\`\n`,
		);
		bot.github.reviews.push({
			pr: pull.number,
			id: 4242,
			user: { login: REVIEWER },
			commit_id: candidate,
			state: "COMMENTED",
			body: `\`\`\`emdash-review-findings\n${JSON.stringify({ findings: [{ id: "F1", severity: "needs_fixing", title: "Missing default", body: "Handle a missing name." }] })}\n\`\`\``,
		});
		await bot.webhook("pull_request", {
			action: "labeled",
			sender: { login: "maintainer" },
			label: { name: "emdash-bot" },
			pull_request: {
				id: pull.id,
				number: pull.number,
				title: pull.title,
				body: pull.body,
				user: { login: "contributor" },
				head: { ref: branch, sha: candidate, repo: { id: 1001 } },
			},
		});
		const caseId = `1001-pr-${pull.id}`;
		const record = await bot.waitFor("repair published", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		const head = bot.github.head(REPO, branch)!;
		expect(bot.github.git(REPO, ["rev-parse", `${head}^`])).toBe(candidate);
		expect(bot.github.show(REPO, head, "greet.js")).toBe(REVISED.content.trimEnd());
		expect(bot.github.pulls).toHaveLength(1);
		expect(record.reviews[0]).toMatchObject({ reviewId: "4242", structured: true });
		expect(record.candidates[0].expectedBranchHead).toBe(candidate);
	});
});

describe("inline-only reviews", () => {
	it("starts repair for a COMMENTED review whose feedback is only inline", async () => {
		bot = await startBot();
		const caseId = issueCaseId(38);
		await bot.webhook("issues", assignIssue({ issueId: 38, number: 38, script: twoRoundScript }));
		const first = await publishedCount(bot, caseId, 1);
		const pr = first.publications[0].prNumber;
		const head = bot.github.head(REPO, "emdash-bot/issue-38")!;
		bot.github.reviewComments.push({
			reviewId: 777,
			id: 55,
			path: "greet.js",
			line: 1,
			body: "Handle a missing name.",
		});
		await bot.webhook("pull_request_review", {
			action: "submitted",
			sender: { login: REVIEWER },
			pull_request: { id: 9038, number: pr },
			review: { id: 777, user: { login: REVIEWER }, commit_id: head, state: "COMMENTED", body: "" },
		});
		const second = await publishedCount(bot, caseId, 2);
		expect(second.reviews.find((r: any) => r.reviewId === "777")).toMatchObject({
			structured: false,
			actionable: 1,
		});
		const message = second.log.find(
			(e: any) => e.type === "review.recorded" && e.data.review === 777,
		);
		expect(message.data.comments).toBe(1);
		const status = await bot.ops(`cases/${caseId}/status`);
		expect(status.status).not.toBe("ready-for-human");
	});
});
