// A small GitHub REST client. Callers interpret status codes themselves so
// that reconciliation can tell "not found" and "already exists" apart from
// transport failures.

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string,
	) {
		super(`GitHub ${path} returned ${status}: ${body.slice(0, 300)}`);
		this.name = "GitHubError";
	}
}

export interface GitHubResponse<T> {
	readonly status: number;
	readonly data: T;
}

export class GitHubClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: () => Promise<string>,
		readonly repo: string,
	) {}

	async raw<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>> {
		const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
		const response = await fetch(url, {
			method,
			headers: {
				authorization: `Bearer ${await this.token()}`,
				accept: "application/vnd.github+json",
				"content-type": "application/json",
				"user-agent": "emdash-bot-pi",
				"x-github-api-version": "2022-11-28",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const textBody = await response.text();
		let data: unknown = textBody;
		try {
			data = textBody ? JSON.parse(textBody) : null;
		} catch {
			// Leave non-JSON bodies as text.
		}
		return { status: response.status, data: data as T };
	}

	async request<T>(
		method: string,
		path: string,
		body?: unknown,
		accept: readonly number[] = [],
	): Promise<T> {
		const response = await this.raw<T>(method, path, body);
		if ((response.status >= 200 && response.status < 300) || accept.includes(response.status))
			return response.data;
		throw new GitHubError(
			response.status,
			path,
			typeof response.data === "string" ? response.data : JSON.stringify(response.data),
		);
	}

	repoPath(suffix: string): string {
		return `/repos/${this.repo}${suffix}`;
	}

	async branchHead(branch: string): Promise<string | null> {
		const response = await this.raw<{ object?: { sha?: string } }>(
			"GET",
			this.repoPath(`/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, "/")}`),
		);
		if (response.status === 404) return null;
		if (response.status !== 200)
			throw new GitHubError(response.status, "branch ref", JSON.stringify(response.data));
		return response.data.object?.sha ?? null;
	}

	async commitTree(sha: string): Promise<string> {
		const commit = await this.request<{ tree: { sha: string } }>(
			"GET",
			this.repoPath(`/git/commits/${sha}`),
		);
		return commit.tree.sha;
	}
}
