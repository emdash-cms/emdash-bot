// Grade the exact published commit in a clean checkout with the private
// grader. Candidate code runs without publication, bot, provider or
// production credentials: the environment is reduced to PATH and a temp HOME.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gitAuthEnv, gitUrl } from "./github.ts";
import type { GraderManifest } from "./types.ts";

export interface GradeResult {
	readonly commit: string;
	readonly grader: GraderManifest["status"];
	readonly steps: Array<{ command: string; exitCode: number; durationMs: number; tail: string }>;
	readonly passed: boolean;
}

function pick(names: readonly string[]): Record<string, string> {
	return Object.fromEntries(
		names.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])),
	);
}

function run(
	cwd: string,
	command: string,
	home: string,
): { exitCode: number; durationMs: number; tail: string } {
	const started = Date.now();
	const result = spawnSync("bash", ["-c", command], {
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			CI: "1",
			// Shared browser cache outside the throwaway HOME, so browsers download once.
			PLAYWRIGHT_BROWSERS_PATH:
				process.env.PLAYWRIGHT_BROWSERS_PATH ??
				join(
					homedir(),
					process.platform === "darwin" ? "Library/Caches" : ".cache",
					"ms-playwright",
				),
			// A store of its own, with copied files: packages that patch their own files on
			// install (workerd swaps in its binary) cannot corrupt a shared, hard-linked store.
			npm_config_store_dir: join(
				homedir(),
				process.platform === "darwin" ? "Library/Caches" : ".cache",
				"emdash-bot-grader-store",
			),
			npm_config_package_import_method: "copy",
			// Trust settings only (for TLS-inspecting networks such as WARP); never credentials.
			...pick(["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]),
		},
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		timeout: 45 * 60_000,
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	return {
		exitCode: result.status ?? 1,
		durationMs: Date.now() - started,
		tail: output.slice(-6000),
	};
}

/**
 * Check out `commit` from `fullName` (or `upstream` when grading a starting
 * commit), overlay the grader's reference tests, and run its commands.
 */
export function grade(
	grader: GraderManifest,
	source: { fullName: string; commit: string; upstream?: string; patch?: string },
): GradeResult {
	const work = mkdtempSync(join(tmpdir(), "eval-grade-"));
	const home = mkdtempSync(join(tmpdir(), "eval-home-"));
	const git = (args: string[]) =>
		execFileSync("git", args, {
			cwd: work,
			env: { PATH: process.env.PATH ?? "", HOME: home, GIT_TERMINAL_PROMPT: "0", ...gitAuthEnv() },
		})
			.toString()
			.trim();
	try {
		git(["init", "-q"]);
		git([
			"fetch",
			"-q",
			"--depth=1",
			"--no-tags",
			source.upstream ?? gitUrl(source.fullName),
			source.commit,
		]);
		git(["checkout", "-q", "FETCH_HEAD"]);
		if (source.patch)
			execFileSync("git", ["apply", "--index", "--binary", source.patch], {
				cwd: work,
				env: { PATH: process.env.PATH ?? "", HOME: home },
			});
		if (grader.referenceCommit && grader.tests.length > 0) {
			git([
				"fetch",
				"-q",
				"--depth=1",
				"--no-tags",
				"https://github.com/emdash-cms/emdash.git",
				grader.referenceCommit,
			]);
			git(["checkout", "FETCH_HEAD", "--", ...grader.tests]);
		}
		const steps: GradeResult["steps"] = [];
		for (const command of grader.setup) {
			let step = run(work, command, home);
			// EmDash's lockfile installs several workerd versions whose install scripts
			// occasionally race; one retry clears it and says nothing about the candidate.
			if (step.exitCode !== 0 && command.startsWith("pnpm install"))
				step = run(work, command, home);
			steps.push({ command, ...step });
			if (step.exitCode !== 0)
				return { commit: source.commit, grader: grader.status, steps, passed: false };
		}
		for (const command of grader.commands) steps.push({ command, ...run(work, command, home) });
		return {
			commit: source.commit,
			grader: grader.status,
			steps,
			passed: steps.every((s) => s.exitCode === 0),
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
}
