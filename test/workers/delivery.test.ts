import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Bot,
	FIX_GREETING,
	REPO,
	REPO_ID,
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

describe("AI disclosure", () => {
	it("names the case's primary model, not the configured default", async () => {
		bot = await startBot({ authorModel: "scripted:configured-default" });
		const caseId = issueCaseId(97);
		await bot.ops(`cases/${caseId}/fixture`, { body: { model: "scripted:author" } });
		await bot.webhook("issues", assignIssue({ issueId: 97, number: 97, script: fixScript() }));
		await bot.waitFor("published", async () => bot!.github.pulls[0]);
		const body = bot.github.pulls[0]!.body;
		expect(body).toContain("model/tool: scripted:author via the EmDash bot");
		expect(body).not.toContain("configured-default");
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

describe("delivery retention", () => {
	it("prunes old unrouted deliveries and keeps the newest", async () => {
		bot = await startBot({ deliveryRetention: { unroutedMs: 0, pruneEveryMs: 0 } });
		const checkRun = (id: number) => ({
			action: "completed",
			sender: { login: "github-actions[bot]" },
			check_run: {
				id,
				name: "CI",
				head_sha: "0".repeat(40),
				status: "completed",
				conclusion: "success",
				pull_requests: [{ number: 999 }],
				check_suite: { head_branch: "someone-else" },
			},
		});
		await bot.webhook("check_run", checkRun(1), "unrouted-1");
		await new Promise((r) => setTimeout(r, 20));
		await bot.webhook("check_run", checkRun(2), "unrouted-2");
		const deliveries: any[] = await bot.ops(`repositories/${REPO_ID}/deliveries`);
		expect(deliveries.map((d) => d.delivery_id)).toEqual(["unrouted-2"]);
		expect(deliveries[0].status).toBe("unrouted");
	});
});
