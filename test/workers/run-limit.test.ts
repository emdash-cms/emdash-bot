// The per-run time limit stops the author between tool calls: a tool call
// already running when the limit passes is allowed to finish.

import { afterEach, describe, expect, it } from "vite-plus/test";
import { type Bot, assignIssue, issueCaseId, startBot } from "../harness.ts";

let bot: Bot | undefined;
afterEach(async () => {
	await bot?.dispose();
	bot = undefined;
});

describe("run limit", () => {
	it("lets a running tool call finish past the limit", async () => {
		bot = await startBot({ budgets: { authorMs: 1_000 }, reconcileMs: 200 });
		const caseId = issueCaseId(99);
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "bash", args: { command: "sleep 3 && echo finished" } },
						{ tool: "handoff", args: { reason: "done", nextAction: "none" } },
					],
				},
			],
		};
		await bot.webhook("issues", assignIssue({ issueId: 99, number: 99, script }));
		const record = await bot.waitFor("handoff", async () => {
			const r = await bot!.inspect(caseId);
			return r.handoff ? r : null;
		});
		expect(record.handoff.reason).toBe("done");
		expect(record.log.some((e: any) => e.type === "author.continued")).toBe(false);
		const evidence = await bot.ops(`cases/${caseId}/evidence`);
		const result = evidence.transcript
			.flatMap((e: any) => e.model ?? [])
			.find((m: any) => m.role === "toolResult" && m.toolName === "bash");
		expect(JSON.stringify(result)).toContain("finished");
	});
});
