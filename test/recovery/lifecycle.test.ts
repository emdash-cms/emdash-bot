// Slice 1 gates: abrupt reset mid-turn, delivery dedupe, events during a
// turn, obsolete generations, and an inspectable transcript.

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Bot,
	BOT,
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

describe("Pi hosted in a case", () => {
	it("survives ctx.abort() during a tool and resumes from the wake alarm", async () => {
		bot = await startBot();
		const caseId = issueCaseId(11);
		await bot.ops(`cases/${caseId}/faults`, { body: { boundary: "during-tool" } });
		await bot.webhook("issues", assignIssue({ issueId: 11, number: 11, script: fixScript() }));
		const record = await published(bot, caseId);
		expect(
			record.log.some((e: any) => e.type === "fault.injected" && e.data.boundary === "during-tool"),
		).toBe(true);
		expect(bot.github.pulls).toHaveLength(1);
		expect(bot.github.show(REPO, bot.github.head(REPO, "emdash-bot/issue-11")!, "greet.js")).toBe(
			FIX_GREETING.content.trimEnd(),
		);
	});

	it("keeps an acknowledged edit across a reset right after its checkpoint commit", async () => {
		bot = await startBot();
		const caseId = issueCaseId(12);
		await bot.ops(`cases/${caseId}/faults`, { body: { boundary: "after-checkpoint-commit" } });
		await bot.webhook("issues", assignIssue({ issueId: 12, number: 12, script: fixScript() }));
		const record = await published(bot, caseId);
		const write = record.operations.find((o: any) => o.kind === "tool:write");
		expect(write.status).toBe("completed");
		// The replay-safe write reran after the reset and reconciled its receipt.
		expect(record.candidates).toHaveLength(1);
		expect(bot.github.show(REPO, bot.github.head(REPO, "emdash-bot/issue-12")!, "greet.js")).toBe(
			FIX_GREETING.content.trimEnd(),
		);
	});

	it("deduplicates repeated deliveries and Pi submissions", async () => {
		bot = await startBot();
		const caseId = issueCaseId(13);
		const payload = assignIssue({ issueId: 13, number: 13, script: fixScript() });
		const first: any = await (await bot.webhook("issues", payload, "delivery-13")).json();
		const second: any = await (await bot.webhook("issues", payload, "delivery-13")).json();
		expect(first.duplicate).toBe(false);
		expect(second.duplicate).toBe(true);
		const record = await published(bot, caseId);
		expect(record.events.filter((e: any) => e.deliveryId === "delivery-13")).toHaveLength(1);
		expect(record.log.filter((e: any) => e.type === "round.start")).toHaveLength(1);
		expect(bot.github.pulls).toHaveLength(1);
	});

	it("keeps an event that arrives during a turn pending until the next round", async () => {
		bot = await startBot();
		const caseId = issueCaseId(14);
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "bash", args: { command: "sleep 2" } },
						{ tool: "handoff", args: { reason: "waiting for direction", nextAction: "answer" } },
					],
				},
				{
					steps: [
						{ tool: "write", args: FIX_GREETING },
						{ tool: "submit_candidate", args: { title: "fix: punctuate", summary: "Done." } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 14, number: 14, script }));
		await bot.waitFor(
			"round 1 running",
			async () => (await bot!.inspect(caseId)).round?.round === 1,
		);
		await bot.webhook("issue_comment", {
			action: "created",
			sender: { login: "maintainer" },
			issue: { id: 14, number: 14 },
			comment: {
				id: 900,
				body: "@emdash-bot-pi please continue with the fix",
				user: { login: "maintainer" },
				author_association: "MEMBER",
			},
		});
		const during = await bot.inspect(caseId);
		const direction = during.events.find((e: any) => e.kind === "direction");
		expect(direction.consumedRound).toBeNull();
		const record = await published(bot, caseId);
		expect(record.events.find((e: any) => e.kind === "direction").consumedRound).toBe(2);
		expect(record.requirements).toHaveLength(2);
	});

	it("refuses tools from an unassigned generation", async () => {
		bot = await startBot();
		const caseId = issueCaseId(15);
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "bash", args: { command: "sleep 2" } },
						{ tool: "write", args: FIX_GREETING },
						{ tool: "submit_candidate", args: { title: "x", summary: "y" } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 15, number: 15, script }));
		await bot.waitFor("round running", async () => (await bot!.inspect(caseId)).round?.round === 1);
		await bot.webhook("issues", {
			action: "unassigned",
			sender: { login: "maintainer" },
			assignee: { login: BOT },
			issue: { id: 15, number: 15 },
		});
		const record = await bot.waitFor("cancelled", async () => {
			const r = await bot!.inspect(caseId);
			return r.state === "cancelled" ? r : null;
		});
		await new Promise((r) => setTimeout(r, 3000));
		const after = await bot.inspect(caseId);
		expect(record.generation).toBe(2);
		expect(after.candidates).toHaveLength(0);
		expect(after.operations.some((o: any) => o.kind === "tool:write")).toBe(false);
		expect(bot.github.pulls).toHaveLength(0);
		expect(after.status.status).toBe("cancelled");
	});

	it("finishes with an inspectable transcript and event log", async () => {
		bot = await startBot();
		const caseId = issueCaseId(16);
		await bot.webhook("issues", assignIssue({ issueId: 16, number: 16, script: fixScript() }));
		await published(bot, caseId);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		expect(evidence.transcript.length).toBeGreaterThan(3);
		const types = new Set(evidence.log.map((e: any) => e.type));
		for (const t of [
			"admission",
			"round.start",
			"checkpoint.commit",
			"candidate.sealed",
			"publication.intent",
			"publication.receipt",
		])
			expect(types).toContain(t);
	});
});

describe("author concurrency", () => {
	it("runs one author round at a time per repository", async () => {
		bot = await startBot();
		const slow = {
			rounds: [
				{
					steps: [
						{ tool: "bash", args: { command: "sleep 2" } },
						{ tool: "write", args: FIX_GREETING },
						{ tool: "submit_candidate", args: { title: "fix: a", summary: "a" } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 41, number: 41, script: slow }));
		await bot.waitFor(
			"first round",
			async () => (await bot!.inspect(issueCaseId(41))).round?.round === 1,
		);
		await bot.webhook("issues", assignIssue({ issueId: 42, number: 42, script: fixScript() }));
		const waiting = await bot.waitFor("second case waits", async () => {
			const r = await bot!.inspect(issueCaseId(42));
			return r.log?.some((e: any) => e.type === "round.waiting-for-slot") ? r : null;
		});
		expect(waiting.round).toBeFalsy();
		for (const id of [41, 42]) {
			await bot.waitFor(`case ${id} published`, async () =>
				(await bot!.inspect(issueCaseId(id))).publications?.some(
					(p: any) => p.state === "pr-ensured",
				),
			);
		}
		const first = await bot.inspect(issueCaseId(41));
		const second = await bot.inspect(issueCaseId(42));
		const firstEnd = first.log.find((e: any) => e.type === "round.end").at;
		const secondStart = second.log.find((e: any) => e.type === "round.start").at;
		expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
	});
});

describe("budgets", () => {
	it("refuses work after the token budget is exhausted but still allows a handoff", async () => {
		bot = await startBot({ budgets: { tokens: -1, cancelMs: 2000, rounds: 4 } });
		const caseId = issueCaseId(51);
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "write", args: FIX_GREETING },
						{
							tool: "handoff",
							args: {
								reason: "budget exhausted after saving work",
								nextAction: "seal or continue",
							},
						},
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 51, number: 51, script }));
		const record = await bot.waitFor("handoff", async () => {
			const r = await bot!.inspect(caseId);
			return r.handoff ? r : null;
		});
		expect(record.handoff.reason).toBe("budget exhausted after saving work");
		expect(record.operations.some((o: any) => o.kind === "tool:write")).toBe(false);
	});
});
