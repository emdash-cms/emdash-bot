// Slice 1 gates: abrupt reset mid-turn, delivery dedupe, events during a
// turn, obsolete generations, and an inspectable transcript.

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Bot,
	BOT,
	FIX_GREETING,
	REPO,
	assignIssue,
	authorBusy,
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
		expect(authorRuns(record)).toHaveLength(1);
		expect(bot.github.pulls).toHaveLength(1);
	});

	it("queues a comment that arrives during a run until the author reaches its next decision point", async () => {
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
		await authorBusy(bot, caseId);
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
		expect(during.pending.map((p: any) => p.status)).toEqual(["running", "queued"]);
		const record = await published(bot, caseId);
		expect(authorRuns(record)).toHaveLength(2);
		expect(record.handoff).toBeNull();
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
		await authorBusy(bot, caseId);
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

	it("keeps the system prompt identical across a run so the prompt cache holds", async () => {
		bot = await startBot();
		const caseId = issueCaseId(19);
		await bot.webhook("issues", assignIssue({ issueId: 19, number: 19, script: fixScript() }));
		await published(bot, caseId);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		const systems = evidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.filter((m: any) => m.role === "system")
			.map((m: any) => JSON.stringify(m.sections ?? m.content));
		// Pi records each change to the system prompt. Live state (budgets, candidate,
		// checks) belongs to case_status, so the prompt changes only when the work is
		// published (the PR number and new base), not on every request.
		expect(systems).toHaveLength(2);
		expect(systems.join("")).not.toContain("tokens remain");
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
			"author.submit",
			"checkpoint.commit",
			"candidate.sealed",
			"publication.intent",
			"publication.receipt",
		])
			expect(types).toContain(t);
	});
});

describe("model failures", () => {
	it("reports a failed model call as needing a human, and a comment retries", async () => {
		bot = await startBot();
		const caseId = issueCaseId(17);
		const script = {
			rounds: [
				{ steps: [{ tool: "model_error", args: { message: "upstream returned nothing" } }] },
				{
					steps: [
						{ tool: "write", args: FIX_GREETING },
						{ tool: "submit_candidate", args: { title: "fix: punctuate", summary: "Done." } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 17, number: 17, script }));
		const failed = await bot.waitFor("handoff", async () => {
			const r = await bot!.inspect(caseId);
			return r.handoff ? r : null;
		});
		expect(failed.handoff.reason).toContain("upstream returned nothing");
		expect(failed.status.status).toBe("needs-human");
		await bot.waitFor("failed label", async () => bot!.github.labels.get(17)?.has("triage/failed"));
		await bot.waitFor("error in the progress comment", async () =>
			bot!.github.comments.find(
				(c) =>
					c.issue === 17 && c.body.includes("The model call failed: upstream returned nothing"),
			),
		);
		await bot.webhook("issue_comment", {
			action: "created",
			sender: { login: "maintainer" },
			issue: { id: 17, number: 17 },
			comment: {
				id: 917,
				body: "Please try again.",
				user: { login: "maintainer" },
				author_association: "MEMBER",
			},
		});
		const record = await published(bot, caseId);
		expect(record.handoff).toBeNull();
		// The failure label goes once the retry works.
		await bot.waitFor(
			"failed label removed",
			async () => !bot!.github.labels.get(17)?.has("triage/failed"),
		);
	});
});

describe("unavailable cases", () => {
	it("reports a case whose object keeps failing, once, and a new assignment starts afresh", async () => {
		bot = await startBot();
		const caseId = issueCaseId(18);
		await bot.ops(`cases/${caseId}/faults`, { body: { boundary: "unavailable" } });
		await bot.webhook("issues", assignIssue({ issueId: 18, number: 18, script: fixScript() }));
		const notice = await bot.waitFor("unavailable notice", async () =>
			bot!.github.comments.find((c) => c.issue === 18 && c.body.includes("emdash-bot:unavailable")),
		);
		expect(notice.body).toContain("Internal error in Durable Object storage");
		await new Promise((r) => setTimeout(r, 1000));
		expect(
			bot.github.comments.filter(
				(c) => c.issue === 18 && c.body.includes("emdash-bot:unavailable"),
			),
		).toHaveLength(1);
		await bot.webhook("issues", {
			action: "unassigned",
			sender: { login: "maintainer" },
			assignee: { login: BOT },
			issue: { id: 18, number: 18 },
		});
		await bot.webhook("issues", assignIssue({ issueId: 18, number: 18, script: fixScript() }));
		const record = await published(bot, `${caseId}-r2`);
		expect(record.publications[0].state).toBe("pr-ensured");
		expect(bot.github.pulls).toHaveLength(1);
	});
});

describe("author concurrency", () => {
	it("runs one author at a time per repository", async () => {
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
		await authorBusy(bot, issueCaseId(41));
		await bot.webhook("issues", assignIssue({ issueId: 42, number: 42, script: fixScript() }));
		const waiting = await bot.waitFor("second case waits", async () => {
			const r = await bot!.inspect(issueCaseId(42));
			return r.log?.some((e: any) => e.type === "author.held") ? r : null;
		});
		expect(authorRuns(waiting)).toHaveLength(0);
		for (const id of [41, 42]) {
			await bot.waitFor(`case ${id} published`, async () =>
				(await bot!.inspect(issueCaseId(id))).publications?.some(
					(p: any) => p.state === "pr-ensured",
				),
			);
		}
		const first = await bot.inspect(issueCaseId(41));
		const second = await bot.inspect(issueCaseId(42));
		const firstEnd = first.log.find((e: any) => e.type === "author.idle").at;
		const secondStart = authorRuns(second)[0].at;
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

describe("reassignment", () => {
	it("restarts the case time budget for a new ownership generation", async () => {
		bot = await startBot({ budgets: { caseMs: 2500, cancelMs: 2000, rounds: 4 } });
		const caseId = issueCaseId(61);
		const script = {
			rounds: [
				{ steps: [{ tool: "handoff", args: { reason: "pausing", nextAction: "reassign" } }] },
				{
					steps: [
						{ tool: "write", args: FIX_GREETING },
						{ tool: "submit_candidate", args: { title: "fix: punctuate", summary: "Done." } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 61, number: 61, script }));
		await bot.waitFor("first handoff", async () => (await bot!.inspect(caseId)).handoff);
		await new Promise((r) => setTimeout(r, 3000));
		const unassign = {
			action: "unassigned",
			sender: { login: "maintainer" },
			assignee: { login: BOT },
			issue: { id: 61, number: 61 },
		};
		await bot.webhook("issues", unassign);
		await bot.webhook("issues", assignIssue({ issueId: 61, number: 61, script }));
		const record = await published(bot, caseId);
		expect(record.generation).toBe(3);
		expect(record.candidates).toHaveLength(1);
	});
});
