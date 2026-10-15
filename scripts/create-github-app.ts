// Create the staging GitHub App with the manifest flow, then record its
// credentials in .env.staging (ignored by git). An org admin approves the
// App in the browser; nothing here runs unattended.
//
//   node --experimental-strip-types scripts/create-github-app.ts [--org emdash-cms] [--name emdash-bot-pi]
//
// Afterwards: install the App on the fixture repository, run this script with
// --installation to record the installation ID, then `pnpm run deploy:staging`.

import { createSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		org: { type: "string", default: "emdash-cms" },
		name: { type: "string", default: "emdash-bot-pi" },
		url: { type: "string", default: "https://emdash-bot-pi.emdash-cms.workers.dev" },
		port: { type: "string", default: "8976" },
		installation: { type: "boolean", default: false },
	},
});

const SECRETS = ".env.staging";
const read = (): Record<string, string> =>
	existsSync(SECRETS) ? (JSON.parse(readFileSync(SECRETS, "utf8")) as Record<string, string>) : {};
const write = (patch: Record<string, string>) =>
	writeFileSync(SECRETS, JSON.stringify({ ...read(), ...patch }, null, 2), { mode: 0o600 });

function appJwt(appId: string, pem: string): string {
	const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const input = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
	return `${input}.${createSign("RSA-SHA256").update(input).sign(pem).toString("base64url")}`;
}

if (values.installation) {
	const secrets = read();
	if (!secrets.GITHUB_APP_ID || !secrets.GITHUB_APP_PRIVATE_KEY)
		throw new Error("create the App first");
	const response = await fetch("https://api.github.com/app/installations", {
		headers: {
			authorization: `Bearer ${appJwt(secrets.GITHUB_APP_ID, secrets.GITHUB_APP_PRIVATE_KEY)}`,
			accept: "application/vnd.github+json",
		},
	});
	const installations = (await response.json()) as Array<{
		id: number;
		account: { login: string };
	}>;
	const installation = installations.find((i) => i.account.login === values.org);
	if (!installation) throw new Error(`no installation on ${values.org}; install the App first`);
	write({ GITHUB_APP_INSTALLATION_ID: String(installation.id) });
	console.log(`Recorded installation ${installation.id}. Next: pnpm run deploy:staging`);
	process.exit(0);
}

const port = Number(values.port);
const manifest = {
	name: values.name,
	url: "https://github.com/emdash-cms/emdash-bot",
	hook_attributes: { url: `${values.url}/webhooks/github`, active: true },
	redirect_url: `http://localhost:${port}/callback`,
	public: false,
	default_permissions: {
		contents: "write",
		pull_requests: "write",
		issues: "write",
		checks: "write",
		metadata: "read",
	},
	default_events: ["issues", "issue_comment", "pull_request", "pull_request_review", "check_run"],
};

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", `http://localhost:${port}`);
	if (url.pathname === "/") {
		response.setHeader("content-type", "text/html");
		response.end(
			`<form method="post" action="https://github.com/organizations/${values.org}/settings/apps/new"><input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'><button>Create ${values.name} on ${values.org}</button></form>`,
		);
		return;
	}
	if (url.pathname === "/callback") {
		const code = url.searchParams.get("code");
		const conversion = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
			method: "POST",
			headers: { accept: "application/vnd.github+json" },
		});
		const app = (await conversion.json()) as {
			id: number;
			slug: string;
			pem: string;
			webhook_secret: string;
			html_url: string;
		};
		write({
			GITHUB_APP_ID: String(app.id),
			GITHUB_APP_PRIVATE_KEY: app.pem,
			GITHUB_WEBHOOK_SECRET: app.webhook_secret,
		});
		response.end(`Created ${app.slug}. Return to the terminal.`);
		console.log(`Created App ${app.slug} (${app.id}); credentials written to ${SECRETS}.`);
		console.log(`1. Set "botLogin": "${app.slug}[bot]" in profiles/staging.json.`);
		console.log(`2. Install it on the fixture repository: ${app.html_url}/installations/new`);
		console.log("3. Delete the fixture repository's own webhook so deliveries are not duplicated.");
		console.log("4. Run this script with --installation, then pnpm run deploy:staging.");
		server.close();
		return;
	}
	response.statusCode = 404;
	response.end();
});
server.listen(port, () =>
	console.log(`Open http://localhost:${port}/ in a browser signed in as a ${values.org} owner.`),
);
