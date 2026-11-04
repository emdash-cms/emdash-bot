// Public issue stats: of the issues opened recently, how many the bot fixed,
// is working on, took on without fixing, or never took on. Issues come from
// GitHub; outcomes come from the board's case summaries.

import { type CaseSummary, STYLES, esc, merged } from "./dashboard.ts";

export type Outcome = "fixed" | "progress" | "unfixed" | "untouched";

export interface OpenedIssue {
	readonly number: number;
	readonly createdAt: number;
}

export interface Bucket {
	readonly start: number;
	readonly end: number;
	readonly counts: Record<Outcome, number>;
}

export interface IssueStats {
	readonly repos: readonly string[];
	readonly generatedAt: number;
	readonly week: Bucket;
	readonly month: Bucket;
	/** Rolling seven-day windows, oldest first, the last ending now. */
	readonly weeks: readonly Bucket[];
}

const DAY = 24 * 3_600_000;
export const STATS_WEEKS = 12;

/** Fixed order: series colours follow the outcome, never its rank. */
export const OUTCOMES: ReadonlyArray<[Outcome, string, string]> = [
	["fixed", "Fixed by the bot", "The bot's pull request was merged"],
	["progress", "In progress", "The bot is working, waiting on CI or review, or ready to merge"],
	["unfixed", "Not fixed by the bot", "Handed to a maintainer, declined, stopped or closed"],
	["untouched", "Not taken on", "The bot has no case for the issue"],
];
const RANK: Record<Outcome, number> = { fixed: 0, progress: 1, unfixed: 2, untouched: 3 };

/** One case's outcome for its issue. */
export function caseOutcome(summary: CaseSummary): Outcome {
	if (merged(summary)) return "fixed";
	switch (summary.group) {
		case "ready":
		case "working":
		case "waiting":
			return "progress";
		default:
			return "unfixed";
	}
}

/** An issue's outcome: its best case, since a retried issue can have several. */
export function issueOutcome(cases: readonly CaseSummary[]): Outcome {
	return cases
		.map(caseOutcome)
		.reduce<Outcome>((best, o) => (RANK[o] < RANK[best] ? o : best), "untouched");
}

export function issueStats(
	repos: readonly string[],
	issues: ReadonlyArray<OpenedIssue & { readonly repo: string }>,
	cases: readonly CaseSummary[],
	now: number,
): IssueStats {
	const byIssue = new Map<string, CaseSummary[]>();
	for (const c of cases) {
		if (c.kind !== "issue") continue;
		const key = `${c.repo}#${c.number}`;
		byIssue.set(key, [...(byIssue.get(key) ?? []), c]);
	}
	const outcomes = issues.map((i) => ({
		createdAt: i.createdAt,
		outcome: issueOutcome(byIssue.get(`${i.repo}#${i.number}`) ?? []),
	}));
	const bucket = (start: number, end: number): Bucket => {
		const counts: Record<Outcome, number> = { fixed: 0, progress: 0, unfixed: 0, untouched: 0 };
		for (const o of outcomes) if (o.createdAt >= start && o.createdAt < end) counts[o.outcome]++;
		return { start, end, counts };
	};
	return {
		repos,
		generatedAt: now,
		week: bucket(now - 7 * DAY, now + 1),
		month: bucket(now - 30 * DAY, now + 1),
		weeks: Array.from({ length: STATS_WEEKS }, (_, i) => {
			const end = now + 1 - (STATS_WEEKS - 1 - i) * 7 * DAY;
			return bucket(end - 7 * DAY, end);
		}),
	};
}

const total = (b: Bucket) => OUTCOMES.reduce((n, [o]) => n + b.counts[o], 0);
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
const day = (ms: number) =>
	new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const range = (b: Bucket) => `${day(b.start)} – ${day(b.end - 1)}`;

function breakdown(b: Bucket): string {
	return OUTCOMES.map(
		([o, label]) =>
			`<li><span class="key ${o}"></span>${esc(label)}<b>${b.counts[o]}</b><span class="share">${pct(b.counts[o], total(b))}</span></li>`,
	).join("");
}

/** A headline tile: the window's issue count, how they were handled, and a share bar. */
function tile(title: string, b: Bucket): string {
	const n = total(b);
	const handled = b.counts.fixed + b.counts.progress;
	const bar = n
		? `<div class="share-bar" role="img" aria-label="${esc(OUTCOMES.map(([o, l]) => `${l}: ${b.counts[o]}`).join(", "))}">${OUTCOMES.filter(
				([o]) => b.counts[o] > 0,
			)
				.map(
					([o, label]) =>
						`<span class="seg ${o}" style="flex-grow:${b.counts[o]}" title="${esc(`${label}: ${b.counts[o]}`)}"></span>`,
				)
				.join("")}</div>`
		: `<div class="share-bar empty"></div>`;
	return `<section class="tile">
<h2>${esc(title)}</h2>
<p class="range">${esc(range(b))}</p>
<p class="hero"><b>${n}</b> issues opened</p>
<p class="headline"><b>${handled}</b> fixed or in progress with the bot (${pct(handled, n)})</p>
${bar}
<ul class="breakdown">${breakdown(b)}</ul>
</section>`;
}

/** Weekly stacked columns, drawn in HTML so each column carries its own hover tooltip. */
function weeklyChart(weeks: readonly Bucket[]): string {
	const max = Math.max(1, ...weeks.map(total));
	// A round axis top just above the tallest week, with a round midpoint.
	const magnitude = 10 ** Math.floor(Math.log10(max));
	const top = [1, 2, 3, 4, 5, 6, 8, 10].map((m) => m * magnitude).find((v) => v >= max)!;
	const ticks = [0, top / 2, top];
	const columns = weeks
		.map((w) => {
			const n = total(w);
			const segments = OUTCOMES.filter(([o]) => w.counts[o] > 0)
				.map(([o]) => `<span class="seg ${o}" style="height:${(w.counts[o] / top) * 100}%"></span>`)
				.join("");
			return `<div class="col" tabindex="0" aria-label="${esc(`${range(w)}: ${n} issues opened`)}">
<div class="stack">${segments}</div>
<span class="x">${esc(day(w.start))}</span>
<div class="tip"><b>${esc(range(w))}</b><span>${n} issues opened</span><ul>${OUTCOMES.map(
				([o, label]) => `<li><span class="key ${o}"></span>${esc(label)}<b>${w.counts[o]}</b></li>`,
			).join("")}</ul></div>
</div>`;
		})
		.join("");
	return `<div class="chart">
<div class="plot">
${ticks.map((t) => `<span class="grid" style="bottom:${(t / top) * 100}%"><span>${t}</span></span>`).join("")}
<div class="cols">${columns}</div>
</div>
</div>`;
}

function table(weeks: readonly Bucket[]): string {
	return `<details class="table-view"><summary>Show as a table</summary>
<table><thead><tr><th scope="col">Week</th><th scope="col">Opened</th>${OUTCOMES.map(([, label]) => `<th scope="col">${esc(label)}</th>`).join("")}</tr></thead>
<tbody>${[...weeks]
		.reverse()
		.map(
			(w) =>
				`<tr><th scope="row">${esc(range(w))}</th><td>${total(w)}</td>${OUTCOMES.map(([o]) => `<td>${w.counts[o]}</td>`).join("")}</tr>`,
		)
		.join("")}</tbody></table></details>`;
}

const STATS_STYLES = `
.viz { --fixed: #2a78d6; --progress: #eb6834; --unfixed: #1baf7a; --untouched: #b5b5b2; }
@media (prefers-color-scheme: dark) {
	:root:where(:not([data-theme="light"])) .viz { --fixed: #3987e5; --progress: #d95926; --unfixed: #199e70; --untouched: #5c5c58; }
}
:root[data-theme="dark"] .viz { --fixed: #3987e5; --progress: #d95926; --unfixed: #199e70; --untouched: #5c5c58; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; margin-top: 1.5rem; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 1.1rem 1.25rem; display: grid; gap: 0.5rem; align-content: start; }
.tile h2 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
.tile p { margin: 0; }
.range { font-size: 0.78rem; color: var(--subtle); font-variant-numeric: tabular-nums; }
.hero { font-size: 0.95rem; color: var(--muted); }
.hero b { font-size: 2.25rem; letter-spacing: -0.03em; color: var(--ink); margin-right: 0.35rem; font-variant-numeric: tabular-nums; }
.headline { font-size: 0.9rem; }
.share-bar { display: flex; gap: 2px; height: 0.75rem; border-radius: 4px; overflow: hidden; margin-block: 0.25rem; }
.share-bar.empty { background: var(--line-soft); }
.share-bar .seg { min-width: 4px; }
.breakdown, .legend, .tip ul { list-style: none; margin: 0; padding: 0; }
.breakdown { display: grid; gap: 0.3rem; font-size: 0.85rem; }
.breakdown li { display: grid; grid-template-columns: 0.75rem 1fr auto 3rem; gap: 0.5rem; align-items: center; font-variant-numeric: tabular-nums; }
.breakdown .share { color: var(--muted); text-align: right; }
.key { width: 0.7rem; height: 0.7rem; border-radius: 3px; display: inline-block; }
.seg.fixed, .key.fixed { background: var(--fixed); }
.seg.progress, .key.progress { background: var(--progress); }
.seg.unfixed, .key.unfixed { background: var(--unfixed); }
.seg.untouched, .key.untouched { background: var(--untouched); }
.legend { display: flex; flex-wrap: wrap; gap: 0.4rem 1.1rem; font-size: 0.8rem; color: var(--muted); margin-top: 1rem; }
.legend li { display: inline-flex; align-items: center; gap: 0.4rem; }
.chart { margin-top: 1rem; padding: 1.25rem 0 0 2rem; }
.plot { position: relative; height: 16rem; }
.grid { position: absolute; left: 0; right: 0; border-top: 1px solid var(--line-soft); }
.grid span { position: absolute; right: calc(100% + 0.5rem); transform: translateY(-50%); font-family: var(--font-mono); font-size: 0.7rem; color: var(--subtle); }
.cols { position: absolute; inset: 0; display: flex; gap: 2px; }
.col { position: relative; flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; outline: none; }
.col:hover, .col:focus-visible { background: color-mix(in srgb, var(--ink) 4%, transparent); border-radius: 4px 4px 0 0; }
.stack { width: min(70%, 2.5rem); height: 100%; display: flex; flex-direction: column-reverse; gap: 2px; }
.stack .seg:last-child { border-radius: 4px 4px 0 0; }
.x { position: absolute; top: calc(100% + 0.4rem); font-family: var(--font-mono); font-size: 0.68rem; color: var(--subtle); white-space: nowrap; }
.col:nth-child(even) .x { visibility: hidden; }
.tip { display: none; position: absolute; bottom: calc(100% + 0.5rem); left: 50%; transform: translateX(-50%); z-index: 2; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 6px 20px #0000001f; padding: 0.6rem 0.75rem; font-size: 0.78rem; width: 15rem; }
.col:first-child .tip, .col:nth-child(2) .tip { left: 0; transform: none; }
.col:last-child .tip, .col:nth-last-child(2) .tip { left: auto; right: 0; transform: none; }
.col:hover .tip, .col:focus-visible .tip { display: grid; gap: 0.3rem; }
.tip > span { color: var(--muted); }
.tip li { display: grid; grid-template-columns: 0.75rem 1fr auto; gap: 0.4rem; align-items: center; font-variant-numeric: tabular-nums; }
.stack-note { font-size: 0.8rem; color: var(--muted); margin: 2.5rem 0 0; }
.table-view { margin-top: 1.25rem; font-size: 0.85rem; }
.table-view summary { cursor: pointer; color: var(--muted); }
.table-view table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-variant-numeric: tabular-nums; }
.table-view th, .table-view td { text-align: right; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--line-soft); }
.table-view th:first-child { text-align: left; font-weight: 500; }
.table-view thead th { color: var(--muted); font-weight: 600; font-size: 0.75rem; }
`;

export function renderStats(stats: IssueStats): string {
	const repo = stats.repos[0] ?? "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>EmDash Autofix · Stats</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
${STYLES}
${STATS_STYLES}
</style>
</head>
<body>
<header class="shell">
<nav class="site-nav" aria-label="Primary navigation">
<a class="logo" href="/">EmDash <strong>Autofix</strong></a>
<div class="nav-links"><a href="/">Board</a><a href="/stats">Stats</a></div>
${repo ? `<a class="nav-cta" href="https://github.com/${esc(repo)}/issues">Find an issue</a>` : ""}
</nav>
</header>
<main class="shell viz">
<section class="intro">
<span class="eyebrow">${esc(stats.repos.join(" · "))} · updated ${esc(new Date(stats.generatedAt).toISOString().slice(11, 16))} UTC</span>
<h1>How issues have been handled</h1>
<p class="lede">Issues opened on GitHub, and where each stands with the bot today. An issue the bot tried more than once counts by its best attempt.</p>
</section>
<div class="tiles">${tile("Past week", stats.week)}${tile("Past 30 days", stats.month)}</div>
<section class="group">
<div class="group-head"><h2>Issues opened each week</h2><span class="group-note">Last ${stats.weeks.length} weeks, by outcome</span></div>
<ul class="legend">${OUTCOMES.map(([o, label, note]) => `<li title="${esc(note)}"><span class="key ${o}"></span>${esc(label)}</li>`).join("")}</ul>
${weeklyChart(stats.weeks)}
<p class="stack-note">Weeks run to today. Hover or focus a week for its numbers.</p>
${table(stats.weeks)}
</section>
<footer class="footer">
<p>${OUTCOMES.map(([, label, note]) => `<strong>${esc(label)}:</strong> ${esc(note[0]!.toLowerCase() + note.slice(1))}.`).join(" ")}</p>
<p>Read-only. Updated every few minutes.</p>
</footer>
</main>
</body>
</html>`;
}
