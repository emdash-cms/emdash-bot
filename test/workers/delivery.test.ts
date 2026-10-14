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
	it("publishes the saved candidate as a draft pull request", async () => {
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
			draft: true,
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
	});
});
