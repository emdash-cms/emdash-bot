// A fake GitHub REST API over real bare git repositories, served to the
// Worker through Miniflare's outbound service. Git Data API writes use git
// plumbing, so tree and commit hashes match what GitHub would compute.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FakePull {
	number: number;
	id: number;
	title: string;
	body: string;
	head: string;
	base: string;
	state: "open" | "closed";
	draft: boolean;
	merged_at: string | null;
}

export interface FakeCheckRun {
	id: number;
	name: string;
	head_sha: string;
	status: string;
	conclusion: string | null;
	output: { title: string | null; summary: string | null; text: string | null };
}

type Mode = "lose-response";

export class FakeGitHub {
	readonly remotes: string;
	pulls: FakePull[] = [];
	comments: Array<{ id: number; issue: number; body: string; user: string }> = [];
	checkRuns: FakeCheckRun[] = [];
	/** Labels by issue or PR number. */
	labels = new Map<number, Set<string>>();
	/** Actions job logs by job (check run) id. */
	jobLogs = new Map<number, string>();
	/** Check runs the bot created itself. */
	statusChecks: FakeCheckRun[] = [];
	reviews: Array<{
		pr: number;
		id: number;
		user: { login: string };
		body: string;
		commit_id: string;
		state: string;
	}> = [];
	reviewComments: Array<{
		reviewId: number;
		id: number;
		path: string;
		line: number;
		body: string;
		inReplyTo?: number;
	}> = [];
	requests: Array<{ method: string; path: string }> = [];
	commitsCreated: string[] = [];
	#faults: Array<{ method: string; pattern: RegExp; mode: Mode }> = [];
	#nextId = 5000;

	constructor(readonly base: string) {
		this.remotes = join(base, "remotes");
	}

	git(
		repo: string,
		args: string[],
		options: { input?: string | Buffer; env?: Record<string, string> } = {},
	): string {
		return execFileSync("git", args, {
			cwd: this.bare(repo),
			input: options.input,
			env: {
				PATH: process.env.PATH ?? "",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				...options.env,
			},
			maxBuffer: 64 * 1024 * 1024,
		})
			.toString("utf8")
			.trim();
	}

	bare(repo: string): string {
		return join(this.remotes, `${repo}.git`);
	}

	/** Create a repository whose default branch holds `files`. */
	createRepo(repo: string, files: Record<string, string>, defaultBranch = "main"): string {
		mkdirSync(this.bare(repo), { recursive: true });
		execFileSync("git", ["init", "-q", "--bare", "-b", defaultBranch, this.bare(repo)]);
		return this.commitFiles(repo, defaultBranch, files, "initial commit", true);
	}

	/**
	 * Commit file changes on top of a branch (a maintainer pushing). The author
	 * name stands in for the GitHub login the compare API reports.
	 */
	commitFiles(
		repo: string,
		branch: string,
		files: Record<string, string | null>,
		message: string,
		initial = false,
		author = "Maintainer",
	): string {
		const work = mkdtempSync(join(tmpdir(), "fake-gh-work-"));
		const env = {
			PATH: process.env.PATH ?? "",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: author,
			GIT_AUTHOR_EMAIL: "m@example.com",
			GIT_COMMITTER_NAME: "Maintainer",
			GIT_COMMITTER_EMAIL: "m@example.com",
		};
		const run = (args: string[]) => execFileSync("git", args, { cwd: work, env }).toString().trim();
		try {
			if (initial) run(["init", "-q", "-b", branch]);
			else {
				run(["init", "-q"]);
				run(["fetch", "-q", this.bare(repo), `refs/heads/${branch}`]);
				run(["checkout", "-q", "-b", branch, "FETCH_HEAD"]);
			}
			for (const [path, content] of Object.entries(files)) {
				if (content === null) rmSync(join(work, path), { force: true });
				else {
					mkdirSync(dirname(join(work, path)), { recursive: true });
					writeFileSync(join(work, path), content);
				}
			}
			run(["add", "-A"]);
			run(["commit", "-q", "-m", message]);
			run(["push", "-q", this.bare(repo), `HEAD:refs/heads/${branch}`]);
			return run(["rev-parse", "HEAD"]);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}

	head(repo: string, branch: string): string | null {
		try {
			return this.git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
		} catch {
			return null;
		}
	}

	show(repo: string, ref: string, path: string): string | null {
		try {
			return this.git(repo, ["show", `${ref}:${path}`]);
		} catch {
			return null;
		}
	}

	/** Open a pull request from an existing branch, as a contributor would. */
	openPull(head: string, title: string, body: string): FakePull {
		const pull: FakePull = {
			number: this.pulls.length + 100,
			id: this.#nextId++,
			title,
			body,
			head,
			base: "main",
			state: "open",
			draft: false,
			merged_at: null,
		};
		this.pulls.push(pull);
		return pull;
	}

	/** Apply the next matching request, then return a 502 as if the response was lost. */
	loseResponse(method: string, pattern: RegExp): void {
		this.#faults.push({ method, pattern, mode: "lose-response" });
	}

	async handler(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.hostname !== "api.github.com")
			return new Response("outbound blocked in tests", { status: 599 });
		const method = request.method;
		const path = url.pathname;
		this.requests.push({ method, path: `${path}${url.search}` });
		const body =
			method === "GET"
				? undefined
				: ((await request.json().catch(() => ({}))) as Record<string, unknown>);
		const response = this.#route(method, url, body);
		const fault = this.#faults.findIndex((f) => f.method === method && f.pattern.test(path));
		if (fault >= 0) {
			this.#faults.splice(fault, 1);
			return new Response("upstream lost", { status: 502 });
		}
		return response;
	}

	#json(data: unknown, status = 200): Response {
		return Response.json(data, { status });
	}

	/** Whether the pull request's head merges into its base without conflicts, as GitHub reports. */
	#mergeable(repo: string, pull: FakePull): boolean | null {
		const base = this.head(repo, pull.base);
		const head = this.head(repo, pull.head);
		if (!base || !head) return null;
		try {
			this.git(repo, ["merge-tree", "--write-tree", base, head]);
			return true;
		} catch {
			return false;
		}
	}

	#route(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
		const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)$/);
		if (!m) return this.#json({ message: "Not Found" }, 404);
		const repo = m[1]!;
		const rest = m[2]!;
		let match: RegExpMatchArray | null;

		if (method === "GET" && (match = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
			const sha = this.head(repo, decodeURIComponent(match[1]!));
			return sha
				? this.#json({ ref: `refs/heads/${match[1]}`, object: { sha, type: "commit" } })
				: this.#json({ message: "Not Found" }, 404);
		}
		if (method === "GET" && (match = rest.match(/^\/git\/commits\/([0-9a-f]+)$/))) {
			try {
				return this.#json({
					sha: match[1],
					tree: { sha: this.git(repo, ["rev-parse", `${match[1]}^{tree}`]) },
				});
			} catch {
				return this.#json({ message: "Not Found" }, 404);
			}
		}
		if (method === "GET" && (match = rest.match(/^\/git\/trees\/([0-9a-f]+)$/))) {
			try {
				return this.git(repo, ["cat-file", "-t", match[1]!]) === "tree"
					? this.#json({ sha: match[1], tree: [] })
					: this.#json({}, 404);
			} catch {
				return this.#json({ message: "Not Found" }, 404);
			}
		}
		if (method === "POST" && rest === "/git/blobs") {
			const content = Buffer.from(
				String(body!.content),
				body!.encoding === "base64" ? "base64" : "utf8",
			);
			return this.#json(
				{ sha: this.git(repo, ["hash-object", "-w", "--stdin"], { input: content }) },
				201,
			);
		}
		if (method === "POST" && rest === "/git/trees") {
			const index = join(this.base, `index-${Date.now()}-${Math.random()}`);
			const env = { GIT_INDEX_FILE: index };
			try {
				if (body!.base_tree) this.git(repo, ["read-tree", body!.base_tree as string], { env });
				for (const entry of body!.tree as Array<{
					path: string;
					mode: string;
					sha: string | null;
				}>) {
					if (entry.sha === null)
						this.git(repo, ["update-index", "--force-remove", entry.path], { env });
					else
						this.git(
							repo,
							["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${entry.path}`],
							{ env },
						);
				}
				return this.#json({ sha: this.git(repo, ["write-tree"], { env }) }, 201);
			} finally {
				rmSync(index, { force: true });
			}
		}
		if (method === "POST" && rest === "/git/commits") {
			const author = body!.author as { name: string; email: string; date: string };
			const env = {
				GIT_AUTHOR_NAME: author.name,
				GIT_AUTHOR_EMAIL: author.email,
				GIT_AUTHOR_DATE: author.date,
				GIT_COMMITTER_NAME: author.name,
				GIT_COMMITTER_EMAIL: author.email,
				GIT_COMMITTER_DATE: author.date,
			};
			const parents = (body!.parents as string[]).flatMap((p) => ["-p", p]);
			const sha = this.git(repo, ["commit-tree", String(body!.tree), ...parents], {
				input: String(body!.message),
				env,
			});
			this.commitsCreated.push(sha);
			return this.#json({ sha }, 201);
		}
		if (method === "POST" && rest === "/git/refs") {
			const ref = String(body!.ref);
			if (this.head(repo, ref.replace("refs/heads/", "")))
				return this.#json({ message: "Reference already exists" }, 422);
			this.git(repo, ["update-ref", ref, String(body!.sha)]);
			return this.#json({ ref, object: { sha: body!.sha } }, 201);
		}
		if (method === "PATCH" && (match = rest.match(/^\/git\/refs\/heads\/(.+)$/))) {
			const branch = decodeURIComponent(match[1]!);
			const current = this.head(repo, branch);
			const next = String(body!.sha);
			if (!current) return this.#json({ message: "Reference does not exist" }, 422);
			if (!body!.force) {
				try {
					this.git(repo, ["merge-base", "--is-ancestor", current, next]);
				} catch {
					return this.#json({ message: "Update is not a fast forward" }, 422);
				}
			}
			this.git(repo, ["update-ref", `refs/heads/${branch}`, next]);
			return this.#json({ object: { sha: next } });
		}
		if (method === "GET" && rest === "/pulls") {
			const head = url.searchParams.get("head")?.split(":")[1];
			return this.#json(this.pulls.filter((p) => !head || p.head === head));
		}
		if (method === "POST" && rest === "/pulls") {
			const head = String(body!.head);
			if (this.pulls.some((p) => p.head === head && p.state === "open"))
				return this.#json({ message: "A pull request already exists" }, 422);
			const pull: FakePull = {
				number: this.pulls.length + 100,
				id: this.#nextId++,
				title: String(body!.title),
				body: String(body!.body),
				head,
				base: String(body!.base),
				state: "open",
				draft: body!.draft === true,
				merged_at: null,
			};
			this.pulls.push(pull);
			return this.#json(
				{ ...pull, html_url: `https://github.com/${repo}/pull/${pull.number}` },
				201,
			);
		}
		if (method === "GET" && (match = rest.match(/^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/))) {
			const [, base, head] = match;
			const ancestor = (a: string, b: string) => {
				try {
					this.git(repo, ["merge-base", "--is-ancestor", a, b]);
					return true;
				} catch {
					return false;
				}
			};
			const status =
				base === head
					? "identical"
					: ancestor(base!, head!)
						? "ahead"
						: ancestor(head!, base!)
							? "behind"
							: "diverged";
			const log = this.git(repo, ["log", "--reverse", "--format=%an%x1f%s", `${base}..${head}`]);
			const commits = log
				? log.split("\n").map((line) => {
						const [login, message] = line.split("\x1f");
						return { author: { login }, commit: { message } };
					})
				: [];
			const mergeBase = this.git(repo, ["merge-base", base!, head!]);
			return this.#json({ status, commits, merge_base_commit: { sha: mergeBase } });
		}
		if (method === "GET" && (match = rest.match(/^\/pulls\/(\d+)$/))) {
			const pull = this.pulls.find((p) => p.number === Number(match![1]));
			if (!pull) return this.#json({ message: "Not Found" }, 404);
			return this.#json({
				...pull,
				head: { sha: this.head(repo, pull.head), ref: pull.head },
				mergeable: this.#mergeable(repo, pull),
				merged: false,
			});
		}
		if (method === "GET" && (match = rest.match(/^\/pulls\/(\d+)\/comments$/))) {
			return this.#json(
				this.reviewComments.map((c) => ({
					id: c.id,
					body: c.body,
					path: c.path,
					line: c.line,
					in_reply_to_id: c.inReplyTo ?? null,
				})),
			);
		}
		if (method === "POST" && (match = rest.match(/^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/))) {
			// Like GitHub, only an inline review comment can be replied to in a thread.
			if (!this.reviewComments.some((c) => c.id === Number(match![2])))
				return this.#json({ message: "Not Found" }, 404);
			const reply = {
				reviewId: 0,
				id: this.#nextId++,
				path: "",
				line: 0,
				body: String(body!.body),
				inReplyTo: Number(match[2]),
			};
			this.reviewComments.push(reply);
			return this.#json({ id: reply.id, in_reply_to_id: reply.inReplyTo }, 201);
		}
		if (method === "GET" && (match = rest.match(/^\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/))) {
			return this.#json(
				this.reviewComments
					.filter((c) => c.reviewId === Number(match![2]))
					.map((c) => ({ ...c, in_reply_to_id: c.inReplyTo ?? null })),
			);
		}
		if (method === "GET" && (match = rest.match(/^\/pulls\/(\d+)\/reviews$/))) {
			return this.#json(this.reviews.filter((r) => r.pr === Number(match![1])));
		}
		if (method === "GET" && (match = rest.match(/^\/commits\/([0-9a-f]+)\/check-runs$/))) {
			return this.#json({
				check_runs: [...this.checkRuns, ...this.statusChecks]
					.filter((c) => c.head_sha === match![1])
					.map((c) => ({ ...c, html_url: "", app: { slug: "github-actions" } })),
			});
		}
		if (method === "POST" && (match = rest.match(/^\/issues\/(\d+)\/labels$/))) {
			const set = this.labels.get(Number(match[1])) ?? new Set<string>();
			for (const label of (body!.labels as string[]) ?? []) set.add(label);
			this.labels.set(Number(match[1]), set);
			return this.#json([...set].map((name) => ({ name })));
		}
		if (method === "DELETE" && (match = rest.match(/^\/issues\/(\d+)\/labels\/(.+)$/))) {
			const set = this.labels.get(Number(match[1]));
			const name = decodeURIComponent(match[2]!);
			if (!set?.delete(name)) return this.#json({ message: "Label does not exist" }, 404);
			return this.#json([...set].map((label) => ({ name: label })));
		}
		if (method === "GET" && (match = rest.match(/^\/pulls\/(\d+)\/files$/))) {
			const pull = this.pulls.find((p) => p.number === Number(match![1]));
			if (!pull) return this.#json({ message: "Not Found" }, 404);
			const head = this.head(repo, pull.head)!;
			const base = this.head(repo, pull.base)!;
			const names = this.git(repo, ["diff", "--name-only", `${base}...${head}`])
				.split("\n")
				.filter(Boolean);
			return this.#json(names.map((filename) => ({ filename })));
		}
		if (method === "GET" && (match = rest.match(/^\/actions\/jobs\/(\d+)\/logs$/))) {
			const log = this.jobLogs.get(Number(match[1]));
			return log === undefined
				? this.#json({ message: "Not Found" }, 404)
				: new Response(log, { headers: { "content-type": "text/plain" } });
		}
		if (method === "POST" && rest === "/check-runs") {
			const run: FakeCheckRun = {
				id: this.#nextId++,
				name: String(body!.name),
				head_sha: String(body!.head_sha),
				status: String(body!.status),
				conclusion: (body!.conclusion as string | undefined) ?? null,
				output: { title: null, summary: null, text: null, ...(body!.output as object) },
			};
			this.statusChecks.push(run);
			return this.#json(run, 201);
		}
		if (method === "PATCH" && (match = rest.match(/^\/check-runs\/(\d+)$/))) {
			const run = this.statusChecks.find((c) => c.id === Number(match![1]));
			if (!run) return this.#json({ message: "Not Found" }, 404);
			Object.assign(run, {
				...(body!.status ? { status: body!.status } : {}),
				...(body!.conclusion ? { conclusion: body!.conclusion } : {}),
				...(body!.output ? { output: { ...run.output, ...(body!.output as object) } } : {}),
			});
			return this.#json(run);
		}
		if (method === "GET" && (match = rest.match(/^\/contents\/(.+)$/))) {
			const content = this.show(
				repo,
				url.searchParams.get("ref") ?? "HEAD",
				decodeURIComponent(match[1]!),
			);
			return content === null
				? this.#json({ message: "Not Found" }, 404)
				: this.#json({ content: Buffer.from(content).toString("base64"), encoding: "base64" });
		}
		if (method === "GET" && (match = rest.match(/^\/issues\/(\d+)\/comments$/))) {
			return this.#json(this.comments.filter((c) => c.issue === Number(match![1])));
		}
		if (method === "POST" && (match = rest.match(/^\/issues\/(\d+)\/comments$/))) {
			const comment = {
				id: this.#nextId++,
				issue: Number(match[1]),
				body: String(body!.body),
				user: "emdash-bot-pi[bot]",
			};
			this.comments.push(comment);
			return this.#json(comment, 201);
		}
		if (method === "PATCH" && (match = rest.match(/^\/issues\/comments\/(\d+)$/))) {
			const comment = this.comments.find((c) => c.id === Number(match![1]));
			if (!comment) return this.#json({}, 404);
			comment.body = String(body!.body);
			return this.#json(comment);
		}
		return this.#json({ message: `fake: unhandled ${method} ${rest}` }, 404);
	}
}
