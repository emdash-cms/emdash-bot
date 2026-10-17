// The public case board: every case the bot has, grouped by who acts next.
// Each CaseDO publishes a small summary to its repository's RepositoryDO when
// its status changes; the board reads those rows. Everything shown is already
// public on GitHub; transcripts, prompts and costs stay behind /ops.

import type { CaseStatus } from "../cases/types.ts";

export type BoardGroup = "human" | "ready" | "working" | "waiting" | "finished";

export interface CaseSummary {
	readonly caseId: string;
	readonly repo: string;
	readonly kind: "issue" | "pr";
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly pr: number | null;
	readonly previewUrl: string | null;
	readonly status: CaseStatus;
	readonly group: BoardGroup;
	readonly queued: boolean;
	readonly reasons: readonly string[];
	readonly nextAction: string;
	readonly assignedBy: string | null;
	readonly autoIntake: boolean;
	readonly createdAt: number;
	readonly lastActivity: number;
	readonly checks: { readonly passed: number; readonly total: number };
	readonly review: string | null;
	readonly reporterConfirmed: boolean;
	readonly plan: ReadonlyArray<{ readonly title: string; readonly status: string }>;
	readonly timeline: ReadonlyArray<{ readonly at: number; readonly text: string }>;
	/** When the case left the board's active groups, for "finished this week". */
	readonly finishedAt: number | null;
}

/** Which group a status belongs to: whoever acts next. */
export function boardGroup(status: CaseStatus): BoardGroup {
	switch (status) {
		case "needs-human":
			return "human";
		case "ready-for-human":
			return "ready";
		case "working":
		case "changes-required":
			return "working";
		case "cancelled":
		case "terminal":
		case "declined":
			return "finished";
		default:
			return "waiting";
	}
}

/** Case log entries shown as milestones, and how each reads. */
const str = (v: unknown): string =>
	typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";

export const MILESTONES: Record<string, (data: Record<string, unknown>) => string | null> = {
	"ownership.assigned": (d) =>
		d.autoIntake ? "Taken on automatically" : d.by ? `Assigned by @${str(d.by)}` : "Assigned",
	"author.held": () => "Waiting for a free slot",
	"publication.receipt": (d) => `Published to pull request #${str(d.pr)}`,
	"candidate.integrated": () => "Rebuilt on top of a new branch head",
	"review.recorded": (d) =>
		`Review from @${str(d.by).replace(/\[bot\]$/, "")}: ${str(d.state).toLowerCase()}`,
	"merge.conflict": () => "Merge conflict with the default branch",
	"default-branch.merged": (d) =>
		Array.isArray(d.conflicts) && d.conflicts.length
			? `Merged the default branch, resolving ${d.conflicts.length} conflict(s)`
			: "Merged the default branch",
	"preview.ready": () => "Preview up; asked the reporter to try it",
	"reporter.confirmed": () => "Reporter confirmed the fix",
	handoff: (d) => `Handed off: ${str(d.reason)}`,
	"case.declined": () => "Declined",
	"ownership.cancelled": () => "Stopped",
	"case.terminal": (d) => (d.merged ? "Merged" : "Closed"),
};

const escapeMap: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};
function esc(value: string | number): string {
	return String(value).replace(/[&<>"']/g, (c) => escapeMap[c]!);
}

function sentence(text: string): string {
	const t = text.trim();
	if (!t) return t;
	const c = t[0]!.toUpperCase() + t.slice(1);
	return /[.!?]$/.test(c) ? c : `${c}.`;
}

function ago(ms: number, now: number): string {
	const minutes = Math.max(0, Math.round((now - ms) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ${minutes % 60} m ago`;
	return `${Math.floor(hours / 24)} d ago`;
}

function duration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes} m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours} h ${minutes % 60} m` : `${Math.floor(hours / 24)} d`;
}

function clock(ms: number, now: number): string {
	const d = new Date(ms);
	if (now - ms > 20 * 3_600_000)
		return d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
	return d.toISOString().slice(11, 16);
}

const PILL: Record<CaseStatus, [string, string]> = {
	working: ["working", "Working"],
	"waiting-for-reply": ["waiting", "Waiting for a reply"],
	"candidate-published": ["waiting", "Waiting for review"],
	"waiting-for-checks": ["waiting", "Waiting for checks"],
	"changes-required": ["working", "Changes requested"],
	"ready-for-human": ["ready", "Ready"],
	"needs-human": ["human", "Needs a maintainer"],
	cancelled: ["done", "Stopped"],
	declined: ["done", "Declined"],
	terminal: ["done", "Closed"],
};

function pill(summary: CaseSummary): string {
	if (summary.queued) return `<span class="pill queued">Waiting for a slot</span>`;
	const [cls, label] = PILL[summary.status];
	const finished =
		summary.status === "terminal" && summary.timeline.at(-1)?.text === "Merged" ? "Merged" : label;
	return `<span class="pill ${cls}">${esc(finished)}</span>`;
}

function evidence(summary: CaseSummary): string {
	if (!summary.pr || summary.group === "finished") return "";
	const chips: string[] = [];
	if (summary.checks.total > 0)
		chips.push(
			`<span class="${summary.checks.passed === summary.checks.total ? "yes" : ""}" title="Required checks passed on the current head">checks ${summary.checks.passed}/${summary.checks.total}</span>`,
		);
	const review = summary.review?.toLowerCase();
	chips.push(
		review
			? `<span class="${review === "approved" ? "yes" : review === "changes_requested" ? "bad" : ""}" title="The reviewer's latest review of the current head">${esc(review === "changes_requested" ? "changes requested" : review)}</span>`
			: `<span class="no" title="No review of the current head yet">review –</span>`,
	);
	if (summary.kind === "issue")
		chips.push(
			summary.reporterConfirmed
				? `<span class="yes" title="The reporter confirmed the fix">reporter ✓</span>`
				: `<span class="no" title="The reporter has not confirmed the fix">reporter –</span>`,
		);
	return `<span class="evidence">${chips.join("")}</span>`;
}

const PLAN_MARK: Record<string, [string, string]> = {
	completed: ["tick", "✓"],
	in_progress: ["now", "●"],
	blocked: ["now", "!"],
	skipped: ["todo", "–"],
};

function row(summary: CaseSummary, now: number): string {
	const repoUrl = `https://github.com/${summary.repo}`;
	const meta: string[] = [];
	if (summary.pr) meta.push(`<a href="${repoUrl}/pull/${summary.pr}">PR #${summary.pr}</a>`);
	if (summary.previewUrl && summary.group !== "finished")
		meta.push(`<a href="${esc(summary.previewUrl)}">preview</a>`);
	meta.push(
		summary.autoIntake
			? "<span>taken on automatically</span>"
			: summary.assignedBy
				? `<span>assigned by @${esc(summary.assignedBy)}</span>`
				: "",
	);
	if (summary.group === "finished" && summary.finishedAt)
		meta.push(`<span>${esc(ago(summary.finishedAt, now))}</span>`);
	else {
		meta.push(`<span>open ${esc(duration(now - summary.createdAt))}</span>`);
		meta.push(`<span>last activity ${esc(ago(summary.lastActivity, now))}</span>`);
	}
	const plan = summary.plan.length
		? `<ul class="plan">${summary.plan
				.map((s) => {
					const [cls, mark] = PLAN_MARK[s.status] ?? ["todo", "○"];
					return `<li><span class="${cls}">${mark}</span>${esc(s.title)}</li>`;
				})
				.join("")}</ul>`
		: `<p class="quiet">${summary.queued ? "No plan yet. The bot writes one when it starts." : "No plan recorded."}</p>`;
	const timeline = summary.timeline.length
		? `<ul class="timeline">${summary.timeline
				.map((t) => `<li><time>${esc(clock(t.at, now))}</time>${esc(t.text)}</li>`)
				.join("")}</ul>`
		: `<p class="quiet">Nothing yet.</p>`;
	const stop =
		summary.group === "finished"
			? ""
			: `<p class="stop">To stop the bot, remove the intake label from the issue or the pull request.</p>`;
	return `<li class="case"><details>
<summary>
<span class="num">#${summary.number}</span>
<span class="main">
<a class="title" href="${esc(summary.url)}">${esc(summary.title || `${summary.kind === "pr" ? "Pull request" : "Issue"} #${summary.number}`)}</a>
${summary.group === "finished" ? "" : `<span class="next">${esc(sentence(summary.nextAction))}</span>`}
<span class="meta">${meta.filter(Boolean).join("")}</span>
</span>
<span class="side">${pill(summary)}${evidence(summary)}</span>
</summary>
<div class="detail">
<span class="spacer"></span>
<div class="panel"><h3>Plan</h3>${plan}</div>
<div class="panel"><h3>Timeline</h3>${timeline}${stop}</div>
</div>
</details></li>`;
}

const GROUPS: ReadonlyArray<[BoardGroup, string, string, string]> = [
	[
		"human",
		"Needs a maintainer",
		"The bot can't go further without you",
		"Nothing needs a maintainer.",
	],
	[
		"ready",
		"Ready for human review",
		"Checks passed, reviewer approved, merges cleanly",
		"Nothing is ready for review.",
	],
	["working", "Working", "", "The bot is idle."],
	["waiting", "Waiting", "On CI, a review, or a reply", "Nothing is waiting."],
	[
		"finished",
		"Finished this week",
		"Merged, closed, declined or stopped",
		"Nothing finished this week.",
	],
];

const SUMMARY_LABEL: Record<BoardGroup, string> = {
	human: "needs a maintainer",
	ready: "ready for review",
	working: "working",
	waiting: "waiting on CI, review or a reply",
	finished: "finished this week",
};

export interface BoardOptions {
	readonly repos: readonly string[];
	readonly intakeLabel: string;
	readonly botHandle: string;
	readonly maxActiveAuthors: number;
	readonly now: number;
}

/** Order within a group: queued cases last (oldest first), the rest by latest activity. */
function ordered(cases: readonly CaseSummary[], group: BoardGroup): CaseSummary[] {
	return cases
		.filter((c) => c.group === group)
		.sort((a, b) =>
			a.queued !== b.queued
				? Number(a.queued) - Number(b.queued)
				: a.queued
					? a.createdAt - b.createdAt
					: group === "finished"
						? (b.finishedAt ?? 0) - (a.finishedAt ?? 0)
						: b.lastActivity - a.lastActivity,
		);
}

export function renderBoard(cases: readonly CaseSummary[], options: BoardOptions): string {
	const { now } = options;
	const running = cases.filter((c) => c.status === "working" && !c.queued).length;
	const queued = cases.filter((c) => c.queued).length;
	const repo = options.repos[0] ?? "";
	const label = encodeURIComponent(`label:${options.intakeLabel}`);
	const chips = (["human", "ready", "working", "waiting"] as const)
		.map((g) => {
			const n = cases.filter((c) => c.group === g).length;
			const extra = g === "working" && queued ? `, <b>${queued}</b> waiting for a slot` : "";
			const cls =
				g === "working" ? "working" : g === "human" ? "human" : g === "ready" ? "ready" : "waiting";
			return `<a href="#${g}"><span class="pill ${cls}">${n}</span>${esc(SUMMARY_LABEL[g])}${extra}</a>`;
		})
		.join("");
	const slots = Array.from(
		{ length: options.maxActiveAuthors },
		(_, i) => `<span class="slot${i < running ? " on" : ""}"></span>`,
	).join("");
	const slotText =
		running >= options.maxActiveAuthors
			? `All ${options.maxActiveAuthors} slots in use${queued ? ` · ${queued} queued` : ""}`
			: `${running} of ${options.maxActiveAuthors} slots in use`;
	const groups = GROUPS.map(([group, title, note, empty]) => {
		const list = ordered(cases, group);
		const groupNote =
			group === "working"
				? `${options.maxActiveAuthors} run at once; the rest start in turn`
				: note;
		return `<section class="group" id="${group}">
<div class="group-head"><h2>${esc(title)} <span class="count">${list.length}</span></h2><span class="group-note">${esc(groupNote)}</span></div>
${list.length ? `<ul class="cases">${list.map((c) => row(c, now)).join("")}</ul>` : `<p class="empty">${esc(empty)}</p>`}
</section>`;
	}).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="refresh" content="60">
<title>EmDash Autofix</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
:root {
	--page: #f9f9f9;
	--surface: #ffffff;
	--surface-soft: #f5f5f4;
	--ink: #262626;
	--muted: #737373;
	--subtle: #a3a3a3;
	--line: #e5e5e5;
	--line-soft: #eeeeec;
	--accent: #ff6633;
	--accent-strong: #e84c1a;
	--accent-ink: #9c2e0b;
	--accent-soft: #fff0e9;
	--heat-12: #fa5d191f;
	--ok: #1f9d55;
	--ok-soft: #e7f6ec;
	--warn: #a86a00;
	--warn-soft: #fdf3dc;
	--wait: #57534e;
	--wait-soft: #f0efed;
	--font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
	--font-mono: "SFMono-Regular", ui-monospace, Consolas, "Liberation Mono", monospace;
	--radius: 0.55rem;
	--shell: min(68rem, 100%);
}
@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) {
		--page: #111110; --surface: #171717; --surface-soft: #222220; --ink: #f3f3f1; --muted: #a8a8a3; --subtle: #777773;
		--line: #30302d; --line-soft: #292927; --accent: #ff7a4d; --accent-strong: #ff8c66; --accent-ink: #ffb49b; --accent-soft: #351d16;
		--heat-12: #ff5e1f1f; --ok: #4ade80; --ok-soft: #13291b; --warn: #ecb730; --warn-soft: #2e2511; --wait: #c4c1bc; --wait-soft: #262624;
		color-scheme: dark;
	}
}
:root[data-theme="dark"] {
	--page: #111110; --surface: #171717; --surface-soft: #222220; --ink: #f3f3f1; --muted: #a8a8a3; --subtle: #777773;
	--line: #30302d; --line-soft: #292927; --accent: #ff7a4d; --accent-strong: #ff8c66; --accent-ink: #ffb49b; --accent-soft: #351d16;
	--heat-12: #ff5e1f1f; --ok: #4ade80; --ok-soft: #13291b; --warn: #ecb730; --warn-soft: #2e2511; --wait: #c4c1bc; --wait-soft: #262624;
	color-scheme: dark;
}
* { box-sizing: border-box; }
body {
	background: var(--page);
	color: var(--ink);
	font-family: var(--font-sans);
	font-size: 15px;
	line-height: 1.5;
	padding-left: max(16px, env(safe-area-inset-left, 0px));
	padding-right: max(16px, env(safe-area-inset-right, 0px));
	padding-block: 0 4rem;
	-webkit-font-smoothing: antialiased;
}
a { color: inherit; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.shell { width: var(--shell); margin-inline: auto; }
.mono { font-family: var(--font-mono); font-size: 0.82em; }

/* Header */
.site-nav { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; height: 5rem; gap: 1rem; }
.logo { display: inline-flex; align-items: baseline; gap: 0.45rem; font-weight: 700; letter-spacing: -0.03em; font-size: 1.15rem; text-decoration: none; }
.logo strong { color: var(--muted); font-weight: 500; }
.nav-links { display: flex; gap: 1.5rem; font-size: 0.85rem; color: var(--muted); }
.nav-links a { text-decoration: none; }
.nav-links a:hover { color: var(--ink); }
.nav-cta { justify-self: end; color: #fff; background: var(--accent); border-radius: var(--radius); padding: 0.6rem 0.9rem; font-size: 0.78rem; font-weight: 600; text-decoration: none; box-shadow: inset 0 1px #ffffff38; transition: background 0.15s, transform 0.15s; }
.nav-cta:hover { background: var(--accent-strong); transform: translateY(-1px); }

/* Intro */
.intro { padding-block: 2.5rem 2rem; display: grid; gap: 1.25rem; }
.eyebrow { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); letter-spacing: 0.02em; }
h1 { margin: 0; font-size: clamp(2rem, 4.5vw, 3.1rem); line-height: 1.02; letter-spacing: -0.055em; text-wrap: balance; max-width: 18ch; }
.lede { margin: 0; color: var(--muted); max-width: 60ch; }
.summary { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.summary a { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.75rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); font-size: 0.82rem; text-decoration: none; font-variant-numeric: tabular-nums; }
.summary a:hover { border-color: var(--subtle); }
.summary b { font-weight: 600; }
.slots { font-size: 0.82rem; color: var(--muted); display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.slot { width: 1.6rem; height: 0.5rem; border-radius: 999px; background: var(--line); }
.slot.on { background: var(--accent); }

/* Groups */
.group { margin-top: 2.5rem; scroll-margin-top: 1rem; }
.group-head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; padding-bottom: 0.75rem; border-bottom: 1px solid var(--line); }
h2 { margin: 0; font-size: 1.15rem; letter-spacing: -0.03em; display: flex; align-items: center; gap: 0.55rem; }
.count { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); font-weight: 400; }
.group-note { font-size: 0.8rem; color: var(--muted); }

/* Case rows */
.cases { list-style: none; margin: 0; padding: 0; }
.case { border-bottom: 1px solid var(--line-soft); }
.case > details > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: 4.5rem minmax(0, 1fr) auto; gap: 0.25rem 1rem; padding-block: 1rem; align-items: start; }
.case > details > summary::-webkit-details-marker { display: none; }
.case > details > summary:hover .title { text-decoration: underline; text-underline-offset: 0.2rem; text-decoration-color: var(--subtle); }
.num { font-family: var(--font-mono); font-size: 0.82rem; color: var(--muted); padding-top: 0.1rem; }
.main { min-width: 0; display: grid; gap: 0.3rem; }
.title { font-weight: 600; letter-spacing: -0.015em; }
.next { color: var(--muted); font-size: 0.88rem; }
.meta { display: flex; flex-wrap: wrap; gap: 0.3rem 0.9rem; font-size: 0.78rem; color: var(--subtle); font-variant-numeric: tabular-nums; }
.meta a { color: var(--muted); }
.side { display: grid; justify-items: end; gap: 0.45rem; }

.pill { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 999px; white-space: nowrap; }
.pill::before { content: ""; width: 0.45rem; height: 0.45rem; border-radius: 50%; background: currentColor; }
.pill.human { color: var(--warn); background: var(--warn-soft); }
.pill.ready { color: var(--ok); background: var(--ok-soft); }
.pill.working { color: var(--accent-ink); background: var(--accent-soft); }
.pill.working::before { background: var(--accent); animation: pulse 1.6s ease-in-out infinite; }
.pill.queued { color: var(--wait); background: var(--wait-soft); }
.pill.queued::before { background: transparent; border: 1.5px solid currentColor; }
.pill.waiting { color: var(--wait); background: var(--wait-soft); }
.pill.done { color: var(--muted); background: transparent; border: 1px solid var(--line); }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .pill.working::before { animation: none; } }

.evidence { display: flex; gap: 0.3rem; align-items: center; }
.evidence span { font-family: var(--font-mono); font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.evidence .yes { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
.evidence .no { color: var(--subtle); }
.evidence .bad { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }

/* Expanded detail */
.detail { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr) minmax(0, 1fr); gap: 1rem; padding-bottom: 1.25rem; font-size: 0.85rem; }
.detail h3 { margin: 0 0 0.5rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
.panel { min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 0.9rem 1rem; }
.plan, .timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
.plan li { display: grid; grid-template-columns: 1.1rem 1fr; gap: 0.4rem; }
.plan .tick { color: var(--ok); }
.plan .now { color: var(--accent); }
.plan .todo { color: var(--subtle); }
.timeline li { display: grid; grid-template-columns: 3.4rem 1fr; gap: 0.6rem; font-variant-numeric: tabular-nums; }
.timeline time { color: var(--subtle); font-family: var(--font-mono); font-size: 0.78rem; }
.stop { margin-top: 0.75rem; font-size: 0.78rem; color: var(--muted); }

.footer { margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; font-size: 0.8rem; color: var(--muted); }
.footer p { margin: 0; max-width: 62ch; }
.sample { display: inline-block; font-family: var(--font-mono); font-size: 0.7rem; color: var(--accent-ink); background: var(--accent-soft); padding: 0.1rem 0.45rem; border-radius: 4px; }

@media (max-width: 720px) {
	.site-nav { grid-template-columns: 1fr auto; height: 4.5rem; }
	.nav-links { display: none; }
	.case > details > summary { grid-template-columns: minmax(0, 1fr); }
	.num { padding-top: 0; }
	.side { justify-items: start; grid-auto-flow: column; justify-content: start; }
	.detail { grid-template-columns: minmax(0, 1fr); }
	.detail .spacer { display: none; }
}
.empty { padding-block: 1rem; color: var(--muted); font-size: 0.88rem; }
.panel p { margin: 0; }
.panel .quiet { color: var(--muted); }
.repo-head { margin-top: 3rem; font-size: 0.8rem; font-family: var(--font-mono); color: var(--muted); }

</style>
</head>
<body>
<header class="shell">
<nav class="site-nav" aria-label="Primary navigation">
<a class="logo" href="/">EmDash <strong>Autofix</strong></a>
<div class="nav-links">${repo ? `<a href="https://github.com/${esc(repo)}/issues?q=is%3Aopen+${label}">Issues</a><a href="https://github.com/${esc(repo)}/pulls?q=is%3Aopen+author%3Aapp%2F${esc(options.botHandle)}">Pull requests</a>` : ""}<a href="#how">How it works</a></div>
${repo ? `<a class="nav-cta" href="https://github.com/${esc(repo)}/issues">Find an issue</a>` : ""}
</nav>
</header>
<main class="shell">
<section class="intro">
<span class="eyebrow">${esc(options.repos.join(" · "))} · updated ${esc(new Date(now).toISOString().slice(11, 16))} UTC</span>
<h1>What the EmDash bot is working on</h1>
<p class="lede">Every issue and pull request the bot has, grouped by who acts next. Everything here is also on GitHub; act there by labelling, commenting or reviewing.</p>
<div class="summary" aria-label="Summary">${chips}</div>
<div class="slots" aria-label="Author slots">${slots}${esc(slotText)}</div>
</section>
${groups}
<footer class="footer" id="how">
<p><strong>How to use the bot.</strong> Add <span class="mono">${esc(options.intakeLabel)}</span> to an issue, or start a comment with <span class="mono">@${esc(options.botHandle)}</span> and say what you want. Remove the label to stop it. A maintainer always approves and merges.</p>
<p>Read-only. Transcripts, prompts and costs stay with operators.</p>
</footer>
</main>
</body>
</html>`;
}
