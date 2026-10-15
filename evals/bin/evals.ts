// Evaluation controller CLI. Agents run in Cloudflare; this coordinates and
// grades them, and can be interrupted and resumed.
//
//   pnpm evals recovery --target local
//   pnpm evals recovery --target pi-staging
//   pnpm evals run --case 4074 --target pi-staging [--fault after-candidate-sealed]
//   pnpm evals run --suite initial-six --target pi-staging
//   pnpm evals run --case 4141 --model cloudflare:@cf/deepseek-ai/deepseek-v4-flash-0731
//   pnpm evals run --case 4141 --model cloudflare-ai-gateway:gpt-6.1-sol --child-model cloudflare-ai-gateway:gpt-5.6-luna
//   pnpm evals resume --attempt <attempt-id>
//   pnpm evals validate --case 4141
//   pnpm evals grade-patch --case 4141 --patch candidate.patch   (grade a dry-run artifact)
//   pnpm evals report

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RESULTS, load, loadCase, newAttempt, runAttempt } from "../controller/attempt.ts";
import { grade } from "../controller/grade.ts";
import type { Profile } from "../controller/types.ts";

const SUITES: Record<string, string[]> = {
	"initial-six": ["4141", "4074", "4070", "4013", "4095", "4024"],
	controls: ["4141", "4074"],
};

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		target: { type: "string", default: "pi-staging" },
		case: { type: "string" },
		suite: { type: "string" },
		fault: { type: "string" },
		model: { type: "string" },
		"child-model": { type: "string" },
		attempt: { type: "string" },
		patch: { type: "string" },
	},
});

function profile(name: string): Profile {
	const path = `evals/profiles/${name}.json`;
	if (!existsSync(path)) throw new Error(`no profile ${name}`);
	const loaded = JSON.parse(readFileSync(path, "utf8")) as Profile;
	if (loaded.owner === "emdash-cms" && loaded.repoPrefix === "emdash")
		throw new Error("a profile targeting emdash-cms/emdash is not an evaluation profile");
	return loaded;
}

async function runCases(
	ids: string[],
	target: string,
	fault: string | null,
	model: string | null,
	childModel: string | null = null,
): Promise<void> {
	const p = profile(target);
	for (const id of ids) {
		const state = newAttempt(id, p, fault, model, childModel);
		try {
			await runAttempt(state, p);
		} catch (error) {
			console.error(
				`[${state.attemptId}] stopped: ${error instanceof Error ? error.message : String(error)}`,
			);
			console.error(`Resume with: pnpm evals resume --attempt ${state.attemptId}`);
			process.exitCode = 1;
		}
	}
}

const [command] = positionals;
switch (command) {
	case "recovery": {
		if (values.target === "local") {
			const started = Date.now();
			const result = spawnSync("node_modules/.bin/vp", ["test", "test/recovery", "test/workers"], {
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf8",
			});
			const id = `recovery-local-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			mkdirSync(join(RESULTS, id), { recursive: true });
			const tail = `${result.stdout}\n${result.stderr}`
				.split("\n")
				.filter((l) => !l.startsWith('{"event"'))
				.slice(-60)
				.join("\n");
			writeFileSync(
				join(RESULTS, id, "summary.json"),
				JSON.stringify(
					{ id, passed: result.status === 0, durationMs: Date.now() - started, tail },
					null,
					2,
				),
			);
			console.log(tail);
			console.log(`${result.status === 0 ? "passed" : "FAILED"}; bundle at ${join(RESULTS, id)}`);
			process.exitCode = result.status ?? 1;
			break;
		}
		const { manifest } = loadCase("delivery-greeting");
		for (const fault of manifest.faultMatrix ?? ["none"])
			await runCases(["delivery-greeting"], values.target!, fault, null);
		break;
	}
	case "run": {
		const ids = values.suite ? SUITES[values.suite] : values.case ? [values.case] : undefined;
		if (!ids) throw new Error("pass --case or --suite");
		await runCases(
			ids,
			values.target!,
			values.fault ?? null,
			values.model ?? null,
			values["child-model"] ?? null,
		);
		break;
	}
	case "resume": {
		if (!values.attempt) throw new Error("pass --attempt");
		const state = load(values.attempt);
		console.log(`[${state.attemptId}] resuming at stage ${state.stage}`);
		await runAttempt(state, profile(state.profile));
		break;
	}
	case "validate": {
		if (!values.case) throw new Error("pass --case");
		const { manifest, grader } = loadCase(values.case);
		if (!manifest.source.startingCommit || !grader.referenceCommit)
			throw new Error("case has no upstream source to validate against");
		console.log("Grading the starting commit (expected to fail)...");
		const before = grade(grader, {
			fullName: "",
			commit: manifest.source.startingCommit,
			upstream: `https://github.com/${manifest.source.repo}.git`,
		});
		console.log("Grading the reference commit (expected to pass)...");
		const after = grade(grader, {
			fullName: "",
			commit: grader.referenceCommit,
			upstream: `https://github.com/${manifest.source.repo}.git`,
		});
		const valid = !before.passed && after.passed;
		const out = join(RESULTS, `validate-${values.case}-${Date.now()}.json`);
		mkdirSync(RESULTS, { recursive: true });
		writeFileSync(out, JSON.stringify({ case: values.case, valid, before, after }, null, 2));
		console.log(
			`${valid ? "VALID" : "NOT VALID"}: starting commit ${before.passed ? "passed" : "failed"}, reference ${after.passed ? "passed" : "failed"}. Details: ${out}`,
		);
		if (valid)
			console.log(
				`Set "status": "validated" in evals/graders/${values.case}.json after reviewing the failure reason.`,
			);
		process.exitCode = valid ? 0 : 1;
		break;
	}
	case "grade-patch": {
		if (!values.case || !values.patch) throw new Error("pass --case and --patch");
		const { manifest, grader } = loadCase(values.case);
		const result = grade(grader, {
			fullName: "",
			commit: manifest.source.startingCommit!,
			upstream: `https://github.com/${manifest.source.repo}.git`,
			patch: join(process.cwd(), values.patch),
		});
		const out = join(RESULTS, `grade-patch-${values.case}-${Date.now()}.json`);
		mkdirSync(RESULTS, { recursive: true });
		writeFileSync(out, JSON.stringify(result, null, 2));
		for (const step of result.steps)
			console.log(
				`${step.exitCode === 0 ? "ok  " : "FAIL"} ${step.command} (${Math.round(step.durationMs / 1000)}s)`,
			);
		console.log(
			`${result.passed ? "PASSED" : "FAILED"} (grader ${grader.status}); details: ${out}`,
		);
		process.exitCode = result.passed ? 0 : 1;
		break;
	}
	case "report": {
		if (!existsSync(RESULTS)) {
			console.log("no results yet");
			break;
		}
		const rows = readdirSync(RESULTS)
			.filter((d) => existsSync(join(RESULTS, d, "summary.json")))
			.map((d) => JSON.parse(readFileSync(join(RESULTS, d, "summary.json"), "utf8")));
		console.log(
			["attempt", "case", "fault", "outcome", "grader", "rounds", "minutes", "human"].join("\t"),
		);
		for (const r of rows) {
			if (!r.case) continue;
			console.log(
				[
					r.attemptId,
					r.case,
					r.fault ?? "-",
					r.outcome,
					r.automated?.privateGrader,
					r.automated?.rounds,
					r.timeMs?.total ? (r.timeMs.total / 60_000).toFixed(1) : "-",
					r.human?.classification ?? "pending",
				].join("\t"),
			);
		}
		break;
	}
	default:
		console.error("commands: recovery, run, resume, validate, report");
		process.exitCode = 2;
}
