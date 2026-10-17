// Ways a maintainer hands work to the bot beyond the label: a comment that
// addresses it (with instructions), and taking over a contributor's pull
// request with its linked issues and earlier feedback.

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Bot,
	FIX_GREETING,
	REPO,
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

const LABEL = "emdash-bot";

function addressed(number: number, body: string, issueBody: string, issueId = number) {
	return {
		action: "created",
		sender: { login: "maintainer" },
		issue: {
			id: issueId,
			number,
			title: "Greeting lacks punctuation",
			body: issueBody,
			html_url: `https://github.com/${REPO}/issues/${number}`,
			user: { login: "reporter" },
			labels: [],
		},
		comment: {
			id: 7000 + number,
			body,
			author_association: "NONE",
			html_url: `https://github.com/${REPO}/issues/${number}#comment`,
		},
	};
}

const scripted = (script: unknown) =>
	`The greeting lacks punctuation.\n\n\`\`\`scripted-author\n${JSON.stringify(script)}\n\`\`\`\n`;

async function transcript(bot: Bot, caseId: string): Promise<string> {
	return JSON.stringify((await bot.ops(`cases/${caseId}/evidence`)).transcript);
}

describe("assignment by a comment addressing the bot", () => {
	it("starts the case with the maintainer's instructions and labels the issue and its pull request", async () => {
		bot = await startBot();
		const caseId = issueCaseId(50);
		await bot.webhook(
			"issue_comment",
			addressed(50, "@emdash-bot-pi keep the greeting short", scripted(fixScript())),
		);
		const record = await bot.waitFor("published", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		expect(record.events[0]).toMatchObject({ kind: "assigned", actor: "maintainer" });
		const pr = record.publications[0].prNumber;
		const text = await transcript(bot, caseId);
		expect(text).toContain("Instructions from maintainers");
		expect(text).toContain("keep the greeting short");
		await bot.waitFor("labels on the issue and the pull request", async () =>
			bot!.github.labels.get(50)?.has(LABEL) && bot!.github.labels.get(pr)?.has(LABEL)
				? true
				: null,
		);

		// Removing the label from the pull request stops the bot and takes its labels off both.
		await bot.webhook("pull_request", {
			action: "unlabeled",
			sender: { login: "maintainer" },
			label: { name: LABEL },
			pull_request: {
				id: 9000,
				number: pr,
				head: { ref: "emdash-bot/issue-50", repo: { id: 1001 } },
			},
		});
		await bot.waitFor("cancelled, labels removed", async () => {
			const r = await bot!.inspect(caseId);
			return r.state === "cancelled" &&
				!bot!.github.labels.get(50)?.has(LABEL) &&
				!bot!.github.labels.get(pr)?.has(LABEL)
				? r
				: null;
		});
	});

	it("delivers a comment addressing the bot on a case it has as the maintainer's comment", async () => {
		bot = await startBot();
		const caseId = issueCaseId(51);
		const script = {
			rounds: [...fixScript().rounds, { steps: [{ tool: "reply", args: { body: "Will do." } }] }],
		};
		await bot.webhook("issues", assignIssue({ issueId: 51, number: 51, script }));
		await bot.waitFor("published", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		await bot.webhook(
			"issue_comment",
			addressed(51, "@emdash-bot-pi also mention the change in the changelog", scripted(script)),
		);
		const record = await bot.waitFor("second run", async () => {
			const r = await bot!.inspect(caseId);
			return authorRuns(r).length >= 2 && r.log.some((e: any) => e.type === "author.idle")
				? r
				: null;
		});
		const text = await transcript(bot, caseId);
		expect(text).toContain("## Comment 7051 on the issue");
		expect(text).toContain("also mention the change in the changelog");
		// A maintainer applied the label; the bot does not label the issue again.
		expect(
			record.log.filter((e: any) => e.type === "intake-label.applied" && e.data.number === 51),
		).toHaveLength(0);
	});
});

describe("taking over a contributor's pull request", () => {
	it("briefs the author with the linked issue, earlier maintainer feedback and another active case", async () => {
		bot = await startBot();
		// The issue the pull request closes already has a case of its own.
		await bot.webhook(
			"issues",
			assignIssue({ issueId: 61, number: 61, script: { rounds: [{ steps: [] }] } }),
		);
		await bot.waitFor("issue case idle", async () => {
			const r = await bot!.inspect(issueCaseId(61));
			return r.log.some((e: any) => e.type === "author.idle") ? r : null;
		});
		bot.github.issues.set(61, {
			title: "Greeting lacks punctuation",
			body: "Visitors see 'Hello Ada' with no comma.",
			user: "reporter",
			state: "open",
		});
		const branch = "fix/punctuation";
		bot.github.git(REPO, ["update-ref", `refs/heads/${branch}`, bot.baseCommit]);
		const head = bot.github.commitFiles(
			REPO,
			branch,
			{ "greet.js": FIX_GREETING.content },
			"fix: comma",
		);
		const pull = bot.github.openPull(
			branch,
			"fix: punctuate the greeting",
			`Closes #61\n\n\`\`\`scripted-author\n${JSON.stringify({ rounds: [{ steps: [] }] })}\n\`\`\`\n`,
		);
		bot.github.comments.push(
			{
				id: 901,
				issue: pull.number,
				body: "Please also handle a missing name.",
				user: "maintainer",
				association: "MEMBER",
			},
			{ id: 902, issue: pull.number, body: "+1 from me", user: "rando", association: "NONE" },
		);
		await bot.webhook("pull_request", {
			action: "labeled",
			sender: { login: "maintainer" },
			label: { name: LABEL },
			pull_request: {
				id: pull.id,
				number: pull.number,
				title: pull.title,
				body: pull.body,
				user: { login: "contributor" },
				head: { ref: branch, sha: head, repo: { id: 1001 } },
			},
		});
		const caseId = `1001-pr-${pull.id}`;
		await bot.waitFor("author briefed", async () => {
			const r = await bot!.inspect(caseId);
			return r.log.some((e: any) => e.type === "author.idle") ? r : null;
		});
		const text = await transcript(bot, caseId);
		expect(text).toContain("opened by @contributor");
		expect(text).toContain("Pull request opened by: contributor");
		expect(text).toContain("Linked issue #61");
		expect(text).toContain("no comma");
		expect(text).toContain("Earlier feedback from maintainers");
		expect(text).toContain("Please also handle a missing name.");
		expect(text).not.toContain("+1 from me");
		expect(text).toContain("Issue #61 also has an active EmDash bot case");
	});

	it("resolves a merge conflict on a pull request it took over", async () => {
		bot = await startBot({ repositories: [{ id: 1001, fullName: REPO, requiredChecks: [] }] });
		const branch = "fix/conflict";
		bot.github.git(REPO, ["update-ref", `refs/heads/${branch}`, bot.baseCommit]);
		const head = bot.github.commitFiles(
			REPO,
			branch,
			{ "greet.js": FIX_GREETING.content },
			"fix: comma",
		);
		const main = bot.github.commitFiles(
			REPO,
			"main",
			{ "greet.js": 'module.exports = (name) => "Hi " + name;\n' },
			"chore: shorten the greeting",
		);
		const RESOLVED = {
			path: "greet.js",
			content: 'module.exports = (name) => "Hi, " + name + "!";\n',
		};
		const script = {
			rounds: [
				{ steps: [] },
				{
					steps: [
						{ tool: "merge_default_branch", args: {} },
						{ tool: "write", args: RESOLVED },
						{ tool: "submit_candidate", args: { title: "fix: greeting", summary: "Merged main." } },
					],
				},
			],
		};
		const pull = bot.github.openPull(
			branch,
			"fix: greeting",
			`Fix.\n\n\`\`\`scripted-author\n${JSON.stringify(script)}\n\`\`\`\n`,
		);
		await bot.webhook("pull_request", {
			action: "labeled",
			sender: { login: "maintainer" },
			label: { name: LABEL },
			pull_request: {
				id: pull.id,
				number: pull.number,
				title: pull.title,
				body: pull.body,
				user: { login: "contributor" },
				head: { ref: branch, sha: head, repo: { id: 1001 } },
			},
		});
		const caseId = `1001-pr-${pull.id}`;
		await bot.waitFor("merge published", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		const published = bot.github.head(REPO, branch)!;
		const parents = bot.github
			.git(REPO, ["rev-list", "--parents", "-n", "1", published])
			.split(" ");
		expect(parents.slice(1)).toEqual([head, main]);
		expect(bot.github.show(REPO, published, "greet.js")).toBe(RESOLVED.content.trimEnd());
	});
});

describe("asking the reporter to try a preview", () => {
	it("tells the author when the preview is up, with the site and package links", async () => {
		bot = await startBot({
			repositories: [
				{
					id: 1001,
					fullName: REPO,
					requiredChecks: [],
					preview: {
						check: "Preview",
						commentAuthor: "preview-bot[bot]",
						packagesCheck: "Packages",
					},
				},
			],
		});
		const caseId = issueCaseId(70);
		const script = {
			rounds: [
				...fixScript().rounds,
				{ steps: [{ tool: "reply", args: { body: "Could you try the preview?", onIssue: true } }] },
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 70, number: 70, script }));
		const record = await bot.waitFor("published", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		const pr = record.publications[0].prNumber;
		const head = bot.github.head(REPO, "emdash-bot/issue-70")!;
		bot.github.comments.push({
			id: 990,
			issue: pr,
			user: "preview-bot[bot]",
			body: "### Preview URL: https://issue-70.preview.example, https://other.example (commit abc)",
		});
		bot.github.checkRuns.push({
			id: 881,
			name: "Packages",
			head_sha: head,
			status: "completed",
			conclusion: "success",
			output: {
				title: "ok",
				summary: "Published",
				text: "[Open in StackBlitz](https://stackblitz.example/t)\n```\nnpm i https://pkg.example/widgets@abc\n```",
			},
		});
		bot.github.checkRuns.push({
			id: 882,
			name: "Preview",
			head_sha: head,
			status: "completed",
			conclusion: "success",
			output: { title: null, summary: "", text: null },
		});
		await bot.webhook("check_run", {
			action: "completed",
			sender: { login: "github-actions[bot]" },
			check_run: {
				id: 882,
				name: "Preview",
				head_sha: head,
				status: "completed",
				conclusion: "success",
				output: { title: "", summary: "", text: "" },
				app: { slug: "github-actions" },
				check_suite: { head_branch: "emdash-bot/issue-70" },
				pull_requests: [{ number: pr }],
			},
		});
		await bot.waitFor("the author asked the reporter", async () => {
			const r = await bot!.inspect(caseId);
			return r.log.some((e: any) => e.type === "preview.ready") && authorRuns(r).length >= 2
				? r
				: null;
		});
		const text = await transcript(bot, caseId);
		expect(text).toContain("## Preview ready");
		expect(text).toContain("https://issue-70.preview.example");
		expect(text).toContain("npm i https://pkg.example/widgets@abc");
		expect(text).toContain("StackBlitz: https://stackblitz.example/t");
		await bot.waitFor(
			"reply on the issue",
			async () =>
				bot!.github.comments.find((c) => c.issue === 70 && c.body.includes("try the preview")) ??
				null,
		);
	});
});

describe("the public board", () => {
	it("lists a case with its status, and filters the data by issue", async () => {
		bot = await startBot({ repositories: [{ id: 1001, fullName: REPO, requiredChecks: [] }] });
		const caseId = issueCaseId(80);
		await bot.webhook("issues", assignIssue({ issueId: 80, number: 80, script: fixScript() }));
		await bot.waitFor("published", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		const data = await bot.waitFor("board row", async () => {
			const response = await bot!.mf.dispatchFetch("https://bot.test/api/cases?issue=80");
			const body = (await response.json()) as { cases: any[] };
			return body.cases.find((c) => c.status === "candidate-published") ? body : null;
		});
		expect(data.cases[0]).toMatchObject({
			caseId,
			number: 80,
			title: "Greeting lacks punctuation",
			group: "waiting",
			assignedBy: "maintainer",
		});
		expect(data.cases[0].timeline.map((t: any) => t.text)).toEqual(
			expect.arrayContaining([
				"Assigned by @maintainer",
				expect.stringMatching(/^Published to pull request #/),
			]),
		);
		const other = await bot.mf.dispatchFetch("https://bot.test/api/cases?issue=81");
		expect(((await other.json()) as { cases: unknown[] }).cases).toHaveLength(0);
		expect(await bot.ops("service")).toMatchObject({ service: "emdash-bot-pi" });
		const html = await (await bot.mf.dispatchFetch("https://bot.test/")).text();
		expect(html).toContain("#80");
		expect(html).toContain("Greeting lacks punctuation");
	});
});
