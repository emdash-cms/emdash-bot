import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Bot,
	FIX_GREETING,
	REPO,
	assignIssue,
	fixScript,
	issueCaseId,
	startBot,
} from "../harness.ts";

let bot: Bot | undefined;
afterEach(async () => {
	await bot?.dispose();
	bot = undefined;
});

describe("issue delivery", () => {
	it("publishes the saved candidate as a pull request ready for review", async () => {
		bot = await startBot();
		const response = await bot.webhook(
			"issues",
			assignIssue({ issueId: 1, number: 7, script: fixScript() }),
		);
		expect(response.status).toBe(202);
		const caseId = issueCaseId(1);
		const record = await bot.waitFor("publication receipt", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		const branchHead = bot.github.head(REPO, "emdash-bot/issue-7")!;
		expect(bot.github.show(REPO, branchHead, "greet.js")).toBe(FIX_GREETING.content.trimEnd());
		const candidate = record.candidates.at(-1);
		expect(bot.github.git(REPO, ["rev-parse", `${branchHead}^{tree}`])).toBe(
			candidate.sourceTreeHash,
		);
		expect(bot.github.pulls).toHaveLength(1);
		expect(bot.github.pulls[0]).toMatchObject({
			draft: false,
			head: "emdash-bot/issue-7",
			base: "main",
		});
		expect(bot.github.pulls[0]!.body).toContain("Closes #7");
		expect(bot.github.pulls[0]!.body).toContain("[x] This PR includes AI-generated code");
		const check = record.verifications.find((v: any) => v.kind === "sandbox");
		expect(check).toMatchObject({
			name: "test",
			outcome: "succeeded",
			treeHash: candidate.sourceTreeHash,
		});
		await bot.waitFor("status comment", async () =>
			bot!.github.comments.find((c) => c.body.includes("emdash-bot:status")),
		);
		// Environment preparation ran once for this base, as a cache step.
		const log = readFileSync(
			join(bot.exec.root(`author-${caseId}`), "workspace", "prepare.log"),
			"utf8",
		);
		expect(log.trim().split("\n")).toHaveLength(1);
	});
});

describe("operator dry run", () => {
	it("seals a candidate at a pinned commit without any GitHub write", async () => {
		bot = await startBot();
		const body = `Fix it.\n\n\`\`\`scripted-author\n${JSON.stringify(fixScript())}\n\`\`\`\n`;
		const admitted = await bot.ops("dry-run", {
			body: {
				repo: REPO,
				repoId: 1001,
				issueNumber: 5,
				title: "Greeting",
				body,
				baseCommit: bot.baseCommit,
				focusedChecks: { test: "node test.js" },
				model: "scripted:author",
			},
		});
		expect(admitted.accepted).toBe(true);
		const record = await bot.waitFor("dry run handoff", async () => {
			const r = await bot!.inspect(admitted.caseId);
			return r.handoff ? r : null;
		});
		expect(record.handoff.reason).toContain("dry run complete");
		expect(record.candidates).toHaveLength(1);
		const writes = bot.github.requests.filter((r) => r.method !== "GET");
		expect(writes).toEqual([]);
		const patch = await bot.mf.dispatchFetch(
			`https://bot.test/ops/cases/${admitted.caseId}/artifact?candidate=${record.candidates[0].id}`,
			{ headers: { authorization: "Bearer test-operator-token" } },
		);
		expect(await patch.text()).toContain('+module.exports = (name) => "Hello, " + name + "!";');
	});
});
