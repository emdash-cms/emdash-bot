// Operator CLI for a deployed bot. Read-only unless an action is selected.
//
//   pnpm ops inspect <case-id>
//   pnpm ops status <case-id>
//   pnpm ops evidence <case-id> [--out file.json]
//   pnpm ops cancel <case-id>
//   pnpm ops resume <case-id> [--direction "text for a new author round"]
//   pnpm ops fault <case-id> <boundary>          (staging only)
//   pnpm ops deliveries <repository-id>
//   pnpm ops smoke model|sandbox [--repo owner/name]
//
// Target: BOT_URL (default https://emdash-bot-pi.emdash-cms.workers.dev).
// Token: OPERATOR_TOKEN, else the OPERATOR_TOKEN in .env.staging.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		out: { type: "string" },
		direction: { type: "string" },
		repo: { type: "string" },
		url: { type: "string" },
	},
});

const base = (
	values.url ??
	process.env.BOT_URL ??
	"https://emdash-bot-pi.emdash-cms.workers.dev"
).replace(/\/$/, "");
const token =
	process.env.OPERATOR_TOKEN ??
	(existsSync(".env.staging")
		? (JSON.parse(readFileSync(".env.staging", "utf8")) as { OPERATOR_TOKEN?: string })
				.OPERATOR_TOKEN
		: undefined);
if (!token) {
	console.error("Set OPERATOR_TOKEN or create .env.staging.");
	process.exit(2);
}

async function call(path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(`${base}/ops/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"x-operator": userInfo().username,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status}: ${text}`);
	return JSON.parse(text);
}

const [command, target, extra] = positionals;
const id = target ? encodeURIComponent(target) : "";
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

switch (command) {
	case "inspect": {
		const record = (await call(`cases/${id}`)) as {
			log?: Array<{ at: number; type: string; data: unknown }>;
		} & Record<string, unknown>;
		const { log, events, ...rest } = record as Record<string, unknown> & {
			log?: unknown[];
			events?: unknown[];
		};
		print(rest);
		console.log(`\n${events?.length ?? 0} events; last log entries:`);
		for (const entry of (log ?? []).slice(-25) as Array<{
			at: number;
			type: string;
			data: unknown;
		}>) {
			console.log(
				`${new Date(entry.at).toISOString()} ${entry.type} ${JSON.stringify(entry.data)}`,
			);
		}
		break;
	}
	case "status":
		print(await call(`cases/${id}/status`));
		break;
	case "evidence": {
		const evidence = await call(`cases/${id}/evidence`);
		if (values.out) {
			writeFileSync(values.out, JSON.stringify(evidence, null, 2));
			console.log(`wrote ${values.out}`);
		} else print(evidence);
		break;
	}
	case "cancel":
		print(await call(`cases/${id}/cancel`, {}));
		break;
	case "resume":
		print(await call(`cases/${id}/resume`, values.direction ? { newRound: values.direction } : {}));
		break;
	case "fault":
		if (!extra) throw new Error("usage: ops fault <case-id> <boundary>");
		print(await call(`cases/${id}/faults`, { boundary: extra }));
		break;
	case "deliveries":
		print(await call(`repositories/${id}/deliveries`));
		break;
	case "smoke":
		print(await call(`smoke/${target ?? "model"}`, values.repo ? { repo: values.repo } : {}));
		break;
	default:
		console.error("commands: inspect, status, evidence, cancel, resume, fault, deliveries, smoke");
		process.exit(2);
}
