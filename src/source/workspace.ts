// Trusted git operations on a sandbox checkout. They run only git plumbing,
// never candidate code, and pass config that disables hooks, fsmonitor and
// external diff drivers a candidate could have planted.

import { type ExecBackend, REPO_DIR, STATE_FILE, WORKSPACE, execOk } from "../execution/backend.ts";
import { text } from "../util.ts";

const GIT = [
	"git",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.quotePath=true",
	"-c",
	"diff.noprefix=false",
	"-c",
	"safe.directory=*",
	"-C",
	REPO_DIR,
] as const;

export function git(...args: string[]): string[] {
	return [...GIT, ...args];
}

export interface PrepareOptions {
	readonly remoteUrl: string;
	readonly baseCommit: string;
	readonly timeoutMs: number;
	readonly prepareCommand?: string;
}

export interface PrepareResult {
	readonly fresh: boolean;
	readonly fetchMs: number;
	readonly prepareMs: number;
}

const PREPARED = `${WORKSPACE}/.emdash-bot-prepared`;

/**
 * Ensure the checkout exists and contains the base commit, and that the
 * environment has been prepared for this base and preparation command. The
 * preparation marker is the environment cache key; dependency output is a
 * cache, never source.
 */
export async function prepareCheckout(
	backend: ExecBackend,
	options: PrepareOptions,
): Promise<PrepareResult> {
	const started = Date.now();
	let fresh = false;
	const has = await backend.exec({
		argv: git("cat-file", "-e", `${options.baseCommit}^{commit}`),
		timeoutMs: 30_000,
	});
	if (has.exitCode !== 0) {
		fresh = true;
		const exists = await backend.exec({ argv: git("rev-parse", "--git-dir"), timeoutMs: 30_000 });
		if (exists.exitCode !== 0) {
			await execOk(
				backend,
				{
					argv: [
						"sh",
						"-c",
						`mkdir -p ${WORKSPACE} && rm -rf ${REPO_DIR} && git init -q ${REPO_DIR}`,
					],
				},
				"checkout init",
			);
		}
		await execOk(
			backend,
			{
				argv: git("fetch", "-q", "--no-tags", "--depth=1", options.remoteUrl, options.baseCommit),
				timeoutMs: options.timeoutMs,
			},
			"base commit fetch",
		);
		await execOk(
			backend,
			{ argv: git("checkout", "-q", "--force", "--detach", options.baseCommit) },
			"base checkout",
		);
	}
	const fetched = Date.now();
	if (!options.prepareCommand) return { fresh, fetchMs: fetched - started, prepareMs: 0 };
	const key = `${options.baseCommit}:${options.prepareCommand}`;
	const marker = await backend.exec({ argv: ["cat", PREPARED] });
	if (marker.exitCode === 0 && text(marker.stdout).trim() === key)
		return { fresh, fetchMs: fetched - started, prepareMs: 0 };
	await execOk(
		backend,
		{ argv: git("checkout", "-q", "--force", "--detach", options.baseCommit) },
		"base checkout for preparation",
	);
	await execOk(
		backend,
		{
			argv: ["sh", "-c", options.prepareCommand],
			cwd: REPO_DIR,
			timeoutMs: Math.max(60_000, options.timeoutMs - (fetched - started)),
		},
		"environment preparation",
	);
	await execOk(
		backend,
		{ argv: ["sh", "-c", `cat > ${PREPARED}`], stdin: new TextEncoder().encode(key) },
		"record preparation",
	);
	return { fresh, fetchMs: fetched - started, prepareMs: Date.now() - fetched };
}

/** Fetch an additional commit (for example an advanced branch head) into the checkout. */
export async function fetchCommit(
	backend: ExecBackend,
	remoteUrl: string,
	commit: string,
	timeoutMs: number,
): Promise<void> {
	const has = await backend.exec({ argv: git("cat-file", "-e", `${commit}^{commit}`) });
	if (has.exitCode === 0) return;
	await execOk(
		backend,
		{ argv: git("fetch", "-q", "--no-tags", "--depth=1", remoteUrl, commit), timeoutMs },
		"commit fetch",
	);
}

export interface CapturedSource {
	readonly patch: Uint8Array;
	readonly treeHash: string;
}

/** Stage the whole working tree and diff it against the base commit. */
export async function captureSource(
	backend: ExecBackend,
	baseCommit: string,
): Promise<CapturedSource> {
	await execOk(backend, { argv: git("add", "-A", "--", ".") }, "stage working tree");
	const diff = await execOk(
		backend,
		{
			argv: git(
				"diff",
				"--binary",
				"--cached",
				"--no-renames",
				"--no-ext-diff",
				"--no-textconv",
				"--full-index",
				"--no-color",
				baseCommit,
				"--",
			),
		},
		"capture diff",
	);
	const tree = await execOk(backend, { argv: git("write-tree") }, "write-tree");
	return { patch: diff.stdout, treeHash: text(tree.stdout).trim() };
}

/**
 * Replace the checkout's source with base + patch and return the resulting
 * tree. Ignored files (dependency caches, build output) are kept.
 */
export async function materialize(
	backend: ExecBackend,
	baseCommit: string,
	patch: Uint8Array | null,
): Promise<string> {
	await execOk(backend, { argv: git("reset", "-q", "--hard", baseCommit) }, "reset to base");
	await execOk(backend, { argv: git("clean", "-fdq") }, "clean untracked files");
	if (patch && patch.byteLength > 0) {
		await execOk(
			backend,
			{ argv: git("apply", "--index", "--binary", "--whitespace=nowarn", "-"), stdin: patch },
			"apply checkpoint",
		);
	}
	const tree = await execOk(backend, { argv: git("write-tree") }, "write-tree");
	return text(tree.stdout).trim();
}

export async function readState(backend: ExecBackend): Promise<string | null> {
	const result = await backend.exec({ argv: ["cat", STATE_FILE] });
	return result.exitCode === 0 ? text(result.stdout).trim() : null;
}

export async function writeState(backend: ExecBackend, value: string): Promise<void> {
	await execOk(
		backend,
		{ argv: ["sh", "-c", `cat > ${STATE_FILE}`], stdin: new TextEncoder().encode(value) },
		"write state marker",
	);
}

export interface TreeChange {
	readonly path: string;
	readonly mode: string;
	/** Blob content; null for a deletion. */
	readonly content: Uint8Array | null;
}

/** The changes between the base commit and the staged tree, with blob contents. */
export async function stagedChanges(
	backend: ExecBackend,
	baseCommit: string,
): Promise<TreeChange[]> {
	const raw = await execOk(
		backend,
		{
			argv: git(
				"diff",
				"--cached",
				"--raw",
				"--no-renames",
				"--full-index",
				"-z",
				baseCommit,
				"--",
			),
		},
		"list staged changes",
	);
	const fields = text(raw.stdout)
		.split("\0")
		.filter((f) => f !== "");
	const changes: TreeChange[] = [];
	for (let i = 0; i < fields.length; i += 2) {
		const [, newMode, , newSha, status] = fields[i]!.slice(1).split(" ");
		const path = fields[i + 1]!;
		if (status === "D") {
			changes.push({ path, mode: "100644", content: null });
			continue;
		}
		const blob = await execOk(
			backend,
			{ argv: git("cat-file", "blob", newSha!) },
			`read blob ${path}`,
		);
		changes.push({ path, mode: newMode!, content: blob.stdout });
	}
	return changes;
}

export async function mergeTreeApply(
	backend: ExecBackend,
	newBase: string,
	patch: Uint8Array,
): Promise<
	{ clean: true; patch: Uint8Array; treeHash: string } | { clean: false; detail: string }
> {
	await execOk(backend, { argv: git("reset", "-q", "--hard", newBase) }, "reset to new base");
	await execOk(backend, { argv: git("clean", "-fdq") }, "clean untracked files");
	const applied = await backend.exec({
		argv: git("apply", "--index", "--binary", "--3way", "--whitespace=nowarn", "-"),
		stdin: patch,
	});
	if (applied.exitCode !== 0) return { clean: false, detail: text(applied.stderr).slice(-2000) };
	const conflicts = await backend.exec({ argv: git("diff", "--name-only", "--diff-filter=U") });
	if (text(conflicts.stdout).trim() !== "")
		return { clean: false, detail: `conflicts in ${text(conflicts.stdout).trim()}` };
	const captured = await captureSource(backend, newBase);
	return { clean: true, ...captured };
}
