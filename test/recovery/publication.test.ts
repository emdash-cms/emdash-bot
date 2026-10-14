// Slice 2 gates and publication faults from the slice 5 suite: the intended
// patch survives sandbox loss without the model, response loss creates no
// duplicate commit or PR, and a reporting failure does not erase publication.

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

const published = (bot: Bot, caseId: string) =>
	bot.waitFor("publication receipt", async () => {
		const r = await bot.inspect(caseId);
		return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
	});

function assertPublishedFix(bot: Bot, record: any, branch: string) {
	const head = bot.github.head(REPO, branch)!;
	const candidate = record.candidates.at(-1);
	expect(bot.github.git(REPO, ["rev-parse", `${head}^{tree}`])).toBe(candidate.sourceTreeHash);
	expect(bot.github.show(REPO, head, "greet.js")).toBe(FIX_GREETING.content.trimEnd());
	const receipt = record.publications.find((p: any) => p.candidateId === candidate.id);
	expect(receipt.commitSha).toBe(head);
	expect(bot.github.pulls.filter((p) => p.head === branch)).toHaveLength(1);
}

describe("saved source and trusted publication", () => {
	it("publishes the sealed artifact after sandbox loss without regenerating it", async () => {
		bot = await startBot();
		const caseId = issueCaseId(21);
		await bot.ops(`cases/${caseId}/faults`, { body: { boundary: "after-candidate-sealed" } });
		await bot.webhook("issues", assignIssue({ issueId: 21, number: 21, script: fixScript() }));
		const record = await published(bot, caseId);
		expect(record.log.some((e: any) => e.type === "fault.injected")).toBe(true);
		expect(record.candidates).toHaveLength(1);
		assertPublishedFix(bot, record, "emdash-bot/issue-21");
		// The publisher materialized the artifact in its own fresh sandbox.
		expect(bot.exec.calls.some((c) => c.name.startsWith("publish-"))).toBe(true);
	});

	it("reconciles a branch update whose response was lost", async () => {
		bot = await startBot();
		const caseId = issueCaseId(22);
		bot.github.loseResponse("POST", /\/git\/refs$/);
		await bot.webhook("issues", assignIssue({ issueId: 22, number: 22, script: fixScript() }));
		const record = await published(bot, caseId);
		expect(bot.github.commitsCreated).toHaveLength(1);
		assertPublishedFix(bot, record, "emdash-bot/issue-22");
	});

	it("reconciles a reset after the branch update applied but before its receipt", async () => {
		bot = await startBot();
		const caseId = issueCaseId(23);
		await bot.ops(`cases/${caseId}/faults`, { body: { boundary: "after-ref-update" } });
		await bot.webhook("issues", assignIssue({ issueId: 23, number: 23, script: fixScript() }));
		const record = await published(bot, caseId);
		expect(record.log.some((e: any) => e.type === "publication.reconciled")).toBe(true);
		expect(new Set(bot.github.commitsCreated).size).toBe(1);
		assertPublishedFix(bot, record, "emdash-bot/issue-23");
	});

	it("does not create a duplicate pull request when the creation response is lost", async () => {
		bot = await startBot();
		const caseId = issueCaseId(24);
		bot.github.loseResponse("POST", /\/pulls$/);
		await bot.webhook("issues", assignIssue({ issueId: 24, number: 24, script: fixScript() }));
		const record = await published(bot, caseId);
		assertPublishedFix(bot, record, "emdash-bot/issue-24");
	});

	it("recovers commit creation after a reset without a replacement patch", async () => {
		bot = await startBot();
		const caseId = issueCaseId(25);
		await bot.ops(`cases/${caseId}/faults`, { body: { boundary: "after-commit-created" } });
		await bot.webhook("issues", assignIssue({ issueId: 25, number: 25, script: fixScript() }));
		const record = await published(bot, caseId);
		expect(new Set(bot.github.commitsCreated).size).toBe(1);
		assertPublishedFix(bot, record, "emdash-bot/issue-25");
	});

	it("keeps the publication receipt when reporting fails", async () => {
		bot = await startBot();
		const caseId = issueCaseId(26);
		await bot.ops(`cases/${caseId}/faults`, { body: { boundary: "report-failure" } });
		await bot.webhook("issues", assignIssue({ issueId: 26, number: 26, script: fixScript() }));
		const record = await bot.waitFor("report failure", async () => {
			const r = await bot!.inspect(caseId);
			return r.log.some((e: any) => e.type === "report.failed") ? r : null;
		});
		const after = await published(bot, caseId);
		expect(after.publications.at(-1).state).toBe("pr-ensured");
		expect(record.log.find((e: any) => e.type === "report.failed")).toBeTruthy();
		assertPublishedFix(bot, after, "emdash-bot/issue-26");
	});

	it("never commits a pointer to a missing artifact when the upload succeeds and the commit is lost", async () => {
		bot = await startBot();
		const caseId = issueCaseId(27);
		await bot.ops(`cases/${caseId}/faults`, { body: { boundary: "after-checkpoint-upload" } });
		await bot.webhook("issues", assignIssue({ issueId: 27, number: 27, script: fixScript() }));
		const record = await published(bot, caseId);
		const bucket: any = await bot.mf.getR2Bucket("ARTIFACTS");
		for (const checkpoint of record.checkpoints)
			expect(await bucket.head(checkpoint.artifactKey)).not.toBeNull();
		// Garbage collection removes only unreferenced objects past the grace period.
		await bucket.put(`cases/${caseId}/checkpoints/orphan.patch`, "x");
		const gc = await bot.ops(`cases/${caseId}/gc`, { body: { graceMs: 0 } });
		expect(gc.deleted).toEqual([`cases/${caseId}/checkpoints/orphan.patch`]);
		for (const checkpoint of record.checkpoints)
			expect(await bucket.head(checkpoint.artifactKey)).not.toBeNull();
		assertPublishedFix(bot, record, "emdash-bot/issue-27");
	});
});
