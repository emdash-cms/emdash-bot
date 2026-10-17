// A parent author hands token-heavy work to a helper model through delegate.
// The helper shares the checkout, cannot publish, and its report comes back
// as the tool result.

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
	});

	it("runs a thorough delegation on the author's own model, not the helper", async () => {
		// A helper model that cannot answer: only the author's model can complete the task.
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
						{ tool: "delegate", args: { task: helperBrief(reviewer), thorough: true } },
						{ tool: "handoff", args: { reason: "done", nextAction: "none" } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 97, number: 97, script }));
		await bot.waitFor("handoff", async () => (await bot!.inspect(caseId)).handoff);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		const results = evidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.filter((m: any) => m.role === "toolResult" && m.toolName === "delegate");
		expect(JSON.stringify(results)).toContain("Review: no defects found.");
	});

	it("runs a thorough delegation on the configured review model", async () => {
		// A review model that cannot answer: the thorough delegation fails, where the helper would not.
		bot = await startBot({
			childModel: "scripted:author",
			reviewModel: "workers-ai:@cf/unavailable/review",
		});
		const caseId = issueCaseId(98);
		const script = {
			rounds: [
				{
					steps: [
						{
							tool: "delegate",
							args: { task: helperBrief({ rounds: [{ steps: [] }] }), thorough: true },
						},
						{ tool: "handoff", args: { reason: "done", nextAction: "none" } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 98, number: 98, script }));
		await bot.waitFor("handoff", async () => (await bot!.inspect(caseId)).handoff);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		const results = evidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.filter((m: any) => m.role === "toolResult" && m.toolName === "delegate");
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
