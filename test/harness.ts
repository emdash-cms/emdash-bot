// Runs the built Worker in Miniflare, from Node. `global-setup.ts` builds it
// once per test run; each test file gets its own Miniflare instance.
//
// `startBot()` adds the bindings `cloudflare.config.ts` declares, with
// Node-side fakes for GitHub (outbound service) and the sandbox (service
// binding). Keep these bindings in step with the Worker config.

import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { compatibilityDate, compatibilityFlags } from "../compatibility.ts";
import { type ExecFake, createExecFake } from "./fakes/exec.ts";
import { FakeGitHub } from "./fakes/github.ts";

export const BUNDLE_DIR = ".cloudflare/output/v0/workers/default/bundle";
export const BUNDLE = `${BUNDLE_DIR}/index.js`;

/** Every module of the built Worker, main module first (the build code-splits lazy imports). */
function bundleModules() {
	const files = readdirSync(BUNDLE_DIR, { recursive: true, encoding: "utf8" }).filter(
		(f) => f.endsWith(".js") && !f.startsWith(".vite"),
	);
	files.sort((a, b) => (a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b)));
	return {
		modules: files.map((f) => ({ type: "ESModule" as const, path: join(BUNDLE_DIR, f) })),
		modulesRoot: BUNDLE_DIR,
	};
}
export const WEBHOOK_SECRET = "test-webhook-secret";
export const OPERATOR_TOKEN = "test-operator-token";
export const REPO = "acme/widgets";
export const REPO_ID = 1001;
export const BOT = "emdash-bot-pi[bot]";
export const REVIEWER = "emdash-review[bot]";

export function startWorker(): Miniflare {
	return new Miniflare(
		convertV4MiniflareOptions({
			...bundleModules(),
			compatibilityDate,
			compatibilityFlags,
			durableObjects: {
				CASES: { className: "CaseDO", useSQLite: true },
				REPOSITORIES: { className: "RepositoryDO", useSQLite: true },
			},
			bindings: { BOT_CONFIG: testConfig("file:///nonexistent") },
		}),
	);
}

export function testConfig(gitRemoteBase: string, overrides: Record<string, unknown> = {}) {
	return {
		profile: "test",
		botLogin: BOT,
		repositories: [
			{
				id: REPO_ID,
				fullName: REPO,
				focusedChecks: { test: "node test.js" },
				prepare: "echo prepared >> /workspace/prepare.log",
			},
		],
		maintainers: ["maintainer"],
		reviewers: [REVIEWER],
		authorModel: "scripted:author",
		thinkingLevel: "off",
		reconcileMs: 250,
		budgets: { cancelMs: 2000, rounds: 4 },
		checks: { code: ["test"], administrative: ["PR Maintenance"], required: ["test"] },
		githubApiUrl: "https://api.github.com",
		gitRemoteBase,
		commitAuthor: { name: BOT, email: "bot@example.com" },
		...overrides,
	};
}

export const INITIAL_FILES: Record<string, string> = {
	"README.md": "# widgets\n",
	"AGENTS.md": "Run `node test.js` before submitting.\n",
	"greet.js": 'module.exports = (name) => "Hello " + name;\n',
	"test.js":
		'const greet = require("./greet");\nif (greet("Ada") !== "Hello, Ada!") { console.error("expected greeting with punctuation"); process.exit(1); }\nconsole.log("ok");\n',
	".github/PULL_REQUEST_TEMPLATE.md":
		"## What does this PR do?\n\n<!-- Describe -->\n\nCloses #\n\n## AI assistance disclosure\n\n- [ ] This PR includes AI-generated code or text — model/tool: <!-- e.g. -->\n",
};

export interface Bot {
	readonly mf: Miniflare;
	readonly github: FakeGitHub;
	readonly exec: ExecFake;
	readonly baseCommit: string;
	webhook(
		event: string,
		payload: Record<string, unknown>,
		deliveryId?: string,
	): Promise<{ status: number; json(): Promise<any>; text(): Promise<string> }>;
	ops(path: string, init?: { method?: string; body?: unknown }): Promise<any>;
	waitFor<T>(
		what: string,
		probe: () => Promise<T | null | undefined | false>,
		timeoutMs?: number,
	): Promise<T>;
	inspect(caseId: string): Promise<any>;
	dispose(): Promise<void>;
}

export const TRIAGE_TAKE_ON = {
	kind: { choice: "bug", probabilities: { bug: 0.9, small_task: 0.05, feature_request: 0.05 } },
	actionable: { noul: 0.9 },
	size: { score: 1 },
};

/**
 * Stands in for Clef. An issue body may carry a `triage-answers` block with the
 * answers to return; otherwise the issue is a clear, small bug.
 */
async function triageFake(request: Request): Promise<Response> {
	const { state } = (await request.json()) as { state: { issue: { body: string } } };
	const block = /```triage-answers\s*\n([\s\S]*?)\n```/.exec(state.issue.body);
	return Response.json(block ? JSON.parse(block[1]!) : TRIAGE_TAKE_ON);
}

export async function startBot(overrides: Record<string, unknown> = {}): Promise<Bot> {
	const base = mkdtempSync(join(tmpdir(), "emdash-bot-test-"));
	const github = new FakeGitHub(base);
	const baseCommit = github.createRepo(REPO, INITIAL_FILES);
	const exec = createExecFake(base);
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			...bundleModules(),
			compatibilityDate,
			compatibilityFlags,
			durableObjects: {
				CASES: { className: "CaseDO", useSQLite: true },
				REPOSITORIES: { className: "RepositoryDO", useSQLite: true },
			},
			r2Buckets: { ARTIFACTS: "artifacts" },
			bindings: {
				BOT_CONFIG: testConfig(`file://${github.remotes}`, overrides),
				GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
				OPERATOR_TOKEN,
				GITHUB_TOKEN: "test-token",
			},
			serviceBindings: {
				EXEC_FAKE: (request: Request) => exec.handler(request),
				TRIAGE_FAKE: triageFake,
			},
			outboundService: (request: Request) => github.handler(request),
		} as Parameters<typeof convertV4MiniflareOptions>[0]),
	);
	const ops = async (path: string, init: { method?: string; body?: unknown } = {}) => {
		const response = await mf.dispatchFetch(`https://bot.test/ops/${path}`, {
			method: init.method ?? (init.body ? "POST" : "GET"),
			headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
			body: init.body ? JSON.stringify(init.body) : undefined,
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`ops ${path} returned ${response.status}: ${text}`);
		return JSON.parse(text);
	};
	return {
		mf,
		github,
		exec,
		baseCommit,
		async webhook(event, payload, deliveryId = randomUUID()) {
			const body = JSON.stringify({
				repository: { id: REPO_ID, full_name: REPO, default_branch: "main" },
				...payload,
			});
			const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
			return mf.dispatchFetch("https://bot.test/webhooks/github", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-github-event": event,
					"x-github-delivery": deliveryId,
					"x-hub-signature-256": signature,
				},
				body,
			});
		},
		ops,
		async waitFor(what, probe, timeoutMs = 30_000) {
			const deadline = Date.now() + timeoutMs;
			let last: unknown;
			for (;;) {
				try {
					const value = await probe();
					if (value) return value as never;
				} catch (error) {
					last = error;
				}
				if (Date.now() > deadline)
					throw new Error(
						`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`,
					);
				await new Promise((r) => setTimeout(r, 100));
			}
		},
		inspect: (caseId) => ops(`cases/${encodeURIComponent(caseId)}`),
		dispose: () => mf.dispose(),
	};
}

export function issueCaseId(issueId: number): string {
	return `${REPO_ID}-issue-${issueId}`;
}

/** An `issues.assigned` payload whose body carries a scripted-author block. */
export function assignIssue(options: {
	issueId: number;
	number: number;
	script?: unknown;
	body?: string;
	sender?: string;
	reporter?: string;
}) {
	const body =
		options.body ??
		`The greeting lacks punctuation.\n\n\`\`\`scripted-author\n${JSON.stringify(options.script)}\n\`\`\`\n`;
	return {
		action: "assigned",
		sender: { login: options.sender ?? "maintainer" },
		assignee: { login: BOT },
		issue: {
			id: options.issueId,
			number: options.number,
			title: "Greeting lacks punctuation",
			body,
			html_url: `https://github.com/${REPO}/issues/${options.number}`,
			user: { login: options.reporter ?? "reporter" },
		},
	};
}

export const FIX_GREETING = {
	path: "greet.js",
	content: 'module.exports = (name) => "Hello, " + name + "!";\n',
};

export function fixScript(extra: unknown[] = []) {
	return {
		rounds: [
			{
				steps: [
					{ tool: "read", args: { path: "greet.js" } },
					{ tool: "write", args: FIX_GREETING },
					{ tool: "run_check", args: { name: "test" } },
					...extra,
					{
						tool: "submit_candidate",
						args: {
							title: "fix: punctuate the greeting",
							summary: "Adds a comma and exclamation mark. `node test.js` passes.",
						},
					},
				],
				final: "Submitted.",
			},
		],
	};
}

/** Author submissions for human-originated messages (excluding the bot's milestone notices). */
export function authorRuns(record: any): any[] {
	return (record.log ?? []).filter(
		(e: any) => e.type === "author.submit" && !/^(published|ready):/.test(String(e.data.key)),
	);
}

/** Wait until the author is working on the case. */
export function authorBusy(bot: Bot, caseId: string): Promise<unknown> {
	return bot.waitFor("author busy", async () => {
		const r = await bot.inspect(caseId);
		return (r.pending ?? []).length > 0 ? r : null;
	});
}
