// Every newly opened issue reaches the author when auto-intake is on. The
// author decides: work on it, ask for information, or decline.

import { afterEach, describe, expect, it } from "vite-plus/test";
import { type Bot, FIX_GREETING, REPO, fixScript, issueCaseId, startBot } from "../harness.ts";

let bot: Bot | undefined;
afterEach(async () => {
	await bot?.dispose();
	bot = undefined;
});

function opened(issueId: number, number: number, script: unknown, opener = "reporter") {
	return {
		action: "opened",
		sender: { login: opener },
		issue: {
			id: issueId,
			number,
			title: "Report",
			body: `Something.\n\n\`\`\`scripted-author\n${JSON.stringify(script)}\n\`\`\`\n`,
			html_url: `https://github.com/${REPO}/issues/${number}`,
			user: { login: opener },
		},
	};
}

const declined = (bot: Bot, caseId: string) =>
	bot.waitFor("declined", async () => {
		const r = await bot.inspect(caseId);
		return r.state === "declined" ? r : null;
	});

describe("auto-intake", () => {
	it("takes on a bounded fix from a newly opened issue", async () => {
		bot = await startBot({ autoIntake: true });
		const caseId = issueCaseId(81);
		await bot.webhook("issues", opened(81, 81, fixScript()));
		const record = await bot.waitFor("published", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		expect(record.events[0]).toMatchObject({
			kind: "assigned",
			provenance: "auto-intake",
			actor: "reporter",
		});
		expect(bot.github.pulls).toHaveLength(1);
	});

	it("declines a feature request with a message and posts nothing else", async () => {
		bot = await startBot({ autoIntake: true });
		const caseId = issueCaseId(82);
		const script = {
			rounds: [
				{
					steps: [
						{
							tool: "decline",
							args: {
								reason: "feature-request",
								message: "Thanks! This is a feature request; please open a discussion.",
							},
						},
					],
				},
			],
		};
		await bot.webhook("issues", opened(82, 82, script));
		const record = await declined(bot, caseId);
		await bot.waitFor("decline message", async () =>
			bot!.github.comments.find((c) => c.issue === 82),
		);
		const comments = bot.github.comments.filter((c) => c.issue === 82);
		expect(comments).toHaveLength(1);
		expect(comments[0]!.body).toContain("feature request");
		expect(record.status.status).toBe("declined");
		expect(bot.github.pulls).toHaveLength(0);
	});

	it("declines a malicious report silently", async () => {
		bot = await startBot({ autoIntake: true });
		const caseId = issueCaseId(83);
		const script = {
			rounds: [
				{
					steps: [
						{ tool: "decline", args: { reason: "malicious", message: "should not be posted" } },
					],
				},
			],
		};
		await bot.webhook("issues", opened(83, 83, script, "spammer"));
		await declined(bot, caseId);
		await new Promise((r) => setTimeout(r, 1500));
		expect(bot.github.comments.filter((c) => c.issue === 83)).toHaveLength(0);
	});

	it("lets a maintainer assign a declined issue anyway", async () => {
		bot = await startBot({ autoIntake: true });
		const caseId = issueCaseId(84);
		const script = {
			rounds: [
				{
					steps: [{ tool: "decline", args: { reason: "out-of-scope", message: "Out of scope." } }],
				},
				{
					steps: [
						{ tool: "write", args: FIX_GREETING },
						{ tool: "submit_candidate", args: { title: "fix: greeting", summary: "Done." } },
					],
				},
			],
		};
		await bot.webhook("issues", opened(84, 84, script));
		await declined(bot, caseId);
		await bot.webhook("issues", {
			action: "labeled",
			sender: { login: "maintainer" },
			label: { name: "emdash-bot" },
			issue: { id: 84, number: 84, title: "Report", body: "", user: { login: "reporter" } },
		});
		const record = await bot.waitFor("published", async () => {
			const r = await bot!.inspect(caseId);
			return r.publications?.some((p: any) => p.state === "pr-ensured") ? r : null;
		});
		expect(record.state).toBe("active");
		expect(record.generation).toBe(2);
	});

	it("ignores newly opened issues when auto-intake is off", async () => {
		bot = await startBot();
		const response: any = await (await bot.webhook("issues", opened(85, 85, fixScript()))).json();
		expect(response.skipped).toBeTruthy();
	});
});
