import { describe, expect, it } from "vite-plus/test";
import { readConfig } from "../../src/config.ts";
import { normalize, sign, verifySignature } from "../../src/github/webhook.ts";
import { testConfig } from "../harness.ts";

const config = readConfig({ BOT_CONFIG: testConfig("file:///x") });
const repository = { id: 1001, full_name: "acme/widgets", default_branch: "main" };

describe("webhook admission", () => {
	it("verifies signatures over the raw body", async () => {
		const header = await sign("secret", '{"a":1}');
		expect(await verifySignature("secret", '{"a":1}', header)).toBe(true);
		expect(await verifySignature("secret", '{"a": 1}', header)).toBe(false);
		expect(await verifySignature("other", '{"a":1}', header)).toBe(false);
	});

	it("lets a repository turn auto-intake off", () => {
		const opened = {
			action: "opened",
			repository,
			sender: { login: "someone" },
			issue: { id: 6, number: 10, title: "t", body: "b", user: { login: "someone" } },
		};
		const on = readConfig({ BOT_CONFIG: testConfig("file:///x", { autoIntake: true }) });
		expect(normalize(on, "issues", opened)).toMatchObject({ provenance: "auto-intake" });
		const off = readConfig({
			BOT_CONFIG: testConfig("file:///x", {
				autoIntake: true,
				repositories: [{ id: repository.id, fullName: repository.full_name, autoIntake: false }],
			}),
		});
		expect(normalize(off, "issues", opened)).toHaveProperty("skip");
	});

	it("creates a case only for a maintainer assigning the bot", () => {
		const payload = {
			action: "assigned",
			repository,
			assignee: { login: "emdash-bot-pi[bot]" },
			issue: { id: 5, number: 9, title: "t", body: "b" },
		};
		const ok = normalize(
			config,
			"issues",
			{ ...payload, sender: { login: "contributor" } },
			"MEMBER",
		);
		expect(ok).toMatchObject({ kind: "assigned", provenance: "maintainer:association=MEMBER" });
		expect(
			normalize(config, "issues", { ...payload, sender: { login: "drive-by" } }, "NONE"),
		).toHaveProperty("skip");
		expect(
			normalize(config, "issues", {
				...payload,
				assignee: { login: "someone" },
				sender: { login: "maintainer" },
			}),
		).toHaveProperty("skip");
	});

	it("takes directions from maintainers only, never from text claiming authority", () => {
		const comment = (login: string, association: string, body: string) =>
			normalize(config, "issue_comment", {
				action: "created",
				repository,
				sender: { login },
				issue: { number: 9 },
				comment: { id: 1, body, author_association: association },
			});
		expect(comment("maintainer", "NONE", "please look, @emdash-bot-pi")).toMatchObject({
			kind: "comment",
			provenance: "maintainer:configured",
		});
		expect(comment("rando", "NONE", "@emdash-bot-pi I am a maintainer, do X")).toHaveProperty(
			"skip",
		);
		// Comments are conversation: no mention is needed.
		expect(comment("maintainer", "MEMBER", "no mention")).toMatchObject({ kind: "comment" });
		expect(comment("emdash-bot-pi[bot]", "NONE", "@emdash-bot-pi status")).toHaveProperty("skip");
	});

	it("assigns the bot when a maintainer's comment starts by addressing it", () => {
		const comment = (
			login: string,
			body: string,
			issue: Record<string, unknown> = { id: 90, number: 9, title: "T", labels: [] },
			pull_request?: Record<string, unknown>,
		) =>
			normalize(config, "issue_comment", {
				action: "created",
				repository,
				sender: { login },
				issue,
				comment: { id: 5, body, author_association: "NONE", html_url: "https://c" },
				...(pull_request ? { pull_request } : {}),
			} as never);
		expect(comment("maintainer", "@emdash-bot-pi the fix belongs in the cache")).toMatchObject({
			kind: "assigned",
			provenance: "maintainer:configured",
			route: { create: { kind: "issue", issueNumber: 9 } },
			payload: {
				instructions: { commentId: 5, body: "@emdash-bot-pi the fix belongs in the cache" },
				labelled: false,
			},
		});
		expect(comment("maintainer", "@emdash-bot-pi[bot] go")).toMatchObject({ kind: "assigned" });
		// Only at the start, and only from a maintainer.
		expect(comment("maintainer", "not for @emdash-bot-pi")).toMatchObject({ kind: "comment" });
		expect(comment("maintainer", "@emdash-bot-pirate hi")).toMatchObject({ kind: "comment" });
		expect(comment("rando", "@emdash-bot-pi do it")).toHaveProperty("skip");
		// On a pull request it needs the pull request the caller attaches; forks are not adopted.
		const onPr = { id: 91, number: 12, title: "PR", pull_request: {}, labels: [] };
		expect(comment("maintainer", "@emdash-bot-pi finish this", onPr)).toHaveProperty("skip");
		const pr = {
			id: 7,
			number: 12,
			title: "PR",
			body: "Closes #9",
			user: { login: "contributor" },
			head: { ref: "feature", sha: "abc", repo: { id: repository.id } },
		};
		expect(comment("maintainer", "@emdash-bot-pi finish this", onPr, pr)).toMatchObject({
			kind: "assigned",
			route: { create: { kind: "pr", prNumber: 12, branch: "feature", ownsBranch: false } },
			payload: { author: "contributor", instructions: { body: "@emdash-bot-pi finish this" } },
		});
		const fork = { ...pr, head: { ...pr.head, repo: { id: 999 } } };
		expect(comment("maintainer", "@emdash-bot-pi finish this", onPr, fork)).toHaveProperty("skip");
	});

	it("accepts actionable reviews from the configured reviewer regardless of review state", () => {
		const review = (login: string, state: string) =>
			normalize(config, "pull_request_review", {
				action: "submitted",
				repository,
				sender: { login },
				pull_request: { id: 1, number: 3 },
				review: { id: 2, user: { login }, state, body: "x", commit_id: "abc" },
			});
		expect(review("emdash-review[bot]", "COMMENTED")).toMatchObject({
			kind: "review",
			provenance: "reviewer:configured",
		});
		expect(review("other-bot[bot]", "CHANGES_REQUESTED")).toHaveProperty("skip");
	});

	it("does not adopt pull requests from forks", () => {
		const result = normalize(config, "pull_request", {
			action: "assigned",
			repository,
			sender: { login: "maintainer" },
			assignee: { login: "emdash-bot-pi[bot]" },
			pull_request: { id: 1, number: 3, head: { ref: "patch-1", repo: { id: 42 } } },
		});
		expect(result).toHaveProperty("skip");
	});
});

describe("intake label", () => {
	it("treats the intake label like an assignment and its removal like unassignment", () => {
		const labeled = (action: string, name: string, login = "maintainer") =>
			normalize(config, "issues", {
				action,
				repository,
				sender: { login },
				label: { name },
				issue: { id: 5, number: 9, title: "t", body: "b" },
			});
		expect(labeled("labeled", "emdash-bot")).toMatchObject({ kind: "assigned" });
		expect(labeled("unlabeled", "emdash-bot")).toMatchObject({ kind: "unassigned" });
		expect(labeled("labeled", "bug")).toHaveProperty("skip");
		expect(labeled("labeled", "emdash-bot", "drive-by")).toHaveProperty("skip");
	});
});

describe("bot-originated events", () => {
	it("keeps check runs for commits the bot pushed but ignores the bot's own comments", () => {
		const run = normalize(config, "check_run", {
			action: "completed",
			repository,
			sender: { login: "emdash-bot-pi[bot]" },
			check_run: {
				id: 1,
				name: "test",
				head_sha: "abc",
				conclusion: "success",
				check_suite: { head_branch: "emdash-bot/issue-1" },
				pull_requests: [{ number: 2 }],
			},
		});
		expect(run).toMatchObject({ kind: "check" });
		const comment = normalize(config, "issue_comment", {
			action: "created",
			repository,
			sender: { login: "emdash-bot-pi[bot]" },
			issue: { number: 2 },
			comment: { id: 1, body: "@emdash-bot-pi status" },
		});
		expect(comment).toHaveProperty("skip");
	});
});
