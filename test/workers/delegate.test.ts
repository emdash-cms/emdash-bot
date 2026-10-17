// A parent author hands token-heavy work to a helper model through delegate,
// and has its change reviewed by independent reviewers through review. Both
// share the checkout, cannot publish, and report back as the tool result.

import { afterEach, describe, expect, it } from "vite-plus/test";
import { type Bot, FIX_GREETING, assignIssue, issueCaseId, startBot } from "../harness.ts";

let bot: Bot | undefined;
afterEach(async () => {
	await bot?.dispose();
	bot = undefined;
});

const helperBrief = (script: unknown) =>
	`Read greet.js and report what it returns.\n\n\`\`\`scripted-author\n${JSON.stringify(script)}\n\`\`\`\n`;

describe("delegate", () => {
	it("returns a helper's report to the parent, which then publishes", async () => {
		bot = await startBot({ childModel: "scripted:author" });
		const caseId = issueCaseId(95);
		const helper = {
			rounds: [
				{
					steps: [{ tool: "read", args: { path: "greet.js" } }],
					final: "greet.js returns Hello + name with no punctuation.",
				},
			],
		};
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "delegate", args: { task: helperBrief(helper) } },
						{ tool: "write", args: FIX_GREETING },
						{ tool: "submit_candidate", args: { title: "fix: punctuate", summary: "Done." } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 95, number: 95, script }));
		await bot.waitFor("published", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		const results = evidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.filter((m: any) => m.role === "toolResult" && m.toolName === "delegate");
		expect(JSON.stringify(results)).toContain("no punctuation");
		expect(bot.github.pulls).toHaveLength(1);
		// The helper's own transcript is available by its conversation id.
		const helperEvidence = await bot.ops(
			`cases/${caseId}/evidence?session=${results[0].details.conversationId}`,
		);
		const helperTools = helperEvidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.filter((m: any) => m.role === "toolResult")
			.map((m: any) => m.toolName);
		expect(helperTools).toEqual(["read"]);
	});

	it("reports a helper that ends without a report as a failed delegation", async () => {
		bot = await startBot({ childModel: "scripted:author" });
		const caseId = issueCaseId(94);
		const helper = {
			rounds: [{ steps: [{ tool: "read", args: { path: "greet.js" } }], final: "" }],
		};
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "delegate", args: { task: helperBrief(helper) } },
						{ tool: "handoff", args: { reason: "done", nextAction: "none" } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 94, number: 94, script }));
		await bot.waitFor("handoff", async () => (await bot!.inspect(caseId)).handoff);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		const result = evidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.find((m: any) => m.role === "toolResult" && m.toolName === "delegate");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("ended without a report. Its last tool call was read");
	});

	it("reviews the change with independent reviewers before submitting", async () => {
		// No review model configured: the reviewers run on the author's own model.
		bot = await startBot({ childModel: "workers-ai:@cf/unavailable/helper" });
		const caseId = issueCaseId(97);
		const reviewer = {
			rounds: [
				{
					steps: [{ tool: "read", args: { path: "greet.js" } }],
					final: "Review: no defects found.",
				},
			],
		};
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "write", args: FIX_GREETING },
						{
							tool: "review",
							args: { title: "fix: punctuate", description: helperBrief(reviewer) },
						},
						{ tool: "submit_candidate", args: { title: "fix: punctuate", summary: "Done." } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 97, number: 97, script }));
		await bot.waitFor("sealed", async () => {
			const r = await bot!.inspect(caseId);
			return r.log.find((e: any) => e.type === "candidate.sealed") ?? null;
		});
		const record = await bot.inspect(caseId);
		const reviewed = record.log.find((e: any) => e.type === "review.completed");
		expect(reviewed?.data.reports).toBe(2);
		const sealed = record.log.find((e: any) => e.type === "candidate.sealed");
		expect(sealed.data.reviewed).toBe(true);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		const results = evidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.filter((m: any) => m.role === "toolResult" && m.toolName === "review");
		const text = JSON.stringify(results);
		expect(text).toContain("Reviewer 2");
		expect(text).toContain("Review: no defects found.");
	});

	it("runs the review on the configured review model", async () => {
		// A review model that cannot answer: the review fails, where the author's model would not.
		bot = await startBot({ reviewModel: "workers-ai:@cf/unavailable/review" });
		const caseId = issueCaseId(98);
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "write", args: FIX_GREETING },
						{
							tool: "review",
							args: { title: "fix", description: helperBrief({ rounds: [{ steps: [] }] }) },
						},
						{ tool: "handoff", args: { reason: "done", nextAction: "none" } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 98, number: 98, script }));
		await bot.waitFor("handoff", async () => (await bot!.inspect(caseId)).handoff);
		const record = await bot.inspect(caseId);
		expect(record.log.some((e: any) => e.type === "review.completed")).toBe(false);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		const results = evidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.filter((m: any) => m.role === "toolResult" && m.toolName === "review");
		expect(JSON.stringify(results)).toMatch(/did not finish|unavailable|error/i);
	});

	it("is unavailable without a helper model", async () => {
		bot = await startBot();
		const caseId = issueCaseId(96);
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "delegate", args: { task: "anything" } },
						{ tool: "handoff", args: { reason: "no helper", nextAction: "none" } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 96, number: 96, script }));
		await bot.waitFor("handoff", async () => (await bot!.inspect(caseId)).handoff);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		expect(JSON.stringify(evidence.transcript)).toContain("no helper model is configured");
	});
});
