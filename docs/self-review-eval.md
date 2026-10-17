# Self-review evaluation (2026-10-17)

Does the author's pre-submit adversarial self-review catch what it missed on its own pull requests? Raw results (transcripts, evidence) are in `evals/results/review-replay/` and `evals/results/self-review-reruns/` (not committed); the answer key is `evals/self-review-answer-key.md`.

## Step 1: replaying the self-review

The author's pre-submit self-review, replayed as a staging dry run (GPT-6.1 Sol, the author's own model) on a private snapshot of each pull request's head, with the issue, the diff, the description and the adversarial review skill from upstream PR 4227. Two runs per pull request. Scored against `evals/self-review-answer-key.md`.

| PR | Key finding | Run 1 | Run 2 |
| --- | --- | --- | --- |
| 4226 | K1 route-cache fresh read gated on an object cache | found | found |
| 4226 | K2 tests set the flag directly | not reported | not reported |
| 4226 | K3 hard expiry, not stale-while-revalidate | not reported | not reported |
| 4225 | K4 widget-area race | missed ("no actionable defects") | missed |
| 4225 | K5 not atomic on Durable Object SQL | missed | missed |
| 4224 | K6 code-stamped rows unreachable; "no migration" false | found | found (reproduced with SQLite) |
| 4224 | K7 case behaviour for string-only configs | not reported | not reported |
| 4221 | K8 quality values break the Cloudflare image endpoint | missed ("no defects") | missed; judged presets correct |
| 4221 | K9 quality ignored in most render paths | missed | missed |
| 4201 | K10 conflicts with `meta.caption` | not reported | not reported |
| 4201 | K11 generated types omit `caption` | found | found |
| 4201 | K12 Edit asset overwrites the per-use caption | not reported | not reported |
| 4201 | K13 seed and export paths | not reported | not reported |

Headline findings: 3 of 5 pull requests (4226, 4224, 4201), consistently across both runs. Missed in 2 of 5 (4225, 4221), with both runs reporting the change as sound.

Caveats: the replay brief asked for findings in a final message, but in 9 of 10 runs the model recorded only a summary in its work plan before handing off, so detailed findings below the headline may be undercounted (K2, K3, K7, K10, K12, K13 are "not reported", not proven missed). In the bot's real flow the review comes back as a delegate's text report, so this capture problem does not apply there.

The misses share a shape: K4 and K5 need the reviewer to look beyond the changed code for the same defect (other seed steps, other storage backends), and K8 and K9 need it to trace the value into another package (the Cloudflare image endpoint) and other render branches. The skill names both ("Scope", "Trace concrete inputs"), but the reviewer did not do either here.

## Step 2: re-running the bot end to end

The bot (staging, GPT-6.1 Sol with Luna helpers, deployed at a2bc67a) re-ran five issues from scratch in private fixtures with the upstream PR 4227 review skill overlaid. Every case ran a thorough (main-model) self-review before submitting. Each resulting pull request was graded by an independent adversarial review against `evals/self-review-answer-key.md`. Per-case notes are beside this file.

| Issue (orig. PR) | Self-review | Key findings | New defects |
| --- | --- | --- | --- |
| 3669 (4225) | ran; "no defects" | K5 resolved (approach needs no atomicity); K4 widgets still missed | low: PostgreSQL FK throw for a losing run (pre-existing) |
| 3686 (4226) | ran; "no defects" | K1, K2, K3 all still present (TTL only; the gap is admitted in the PR body) | none |
| 3018 (4201) | found K11, then fixed and re-verified | K11 fixed; K10, K12, K13 still present | medium: id-only writes still lack top-level caption |
| 3577 (4224) | found K6 and two follow-on defects, fixed them over three rounds | K6 partly fixed (entries and collections); K7 still present | **critical**: build breaks for object-locale sites (strict manifest schema; an existing test fails) |
| 3592 (4221) | ran; "no defects" | K8, K9 still present | none |

Key findings resolved: K5, K11, and half of K6, out of 13; the rest persist. The self-review changed the shipped code in two of five cases (3018, 3577), and in both it found the same headline issue the independent reviewers had flagged on the original pull requests. It missed whatever needed tracing into another package or backend (K1, K4, K8), matching the step 1 replay. One re-run introduced a critical regression that a focused run of the package's existing tests would have caught.

Environment notes: fixture CI cannot run EmDash's workflows (runner heap, no API access), so CI evidence was unavailable and 3018 handed off on it; the first 3577 attempt failed on GitHub 429s while ten replay sandboxes and five cases cloned the repository at once.

### Per case

#### Re-run 3669 (original PR 4225)

Fixture PR emdash-cms/emdash-bot-pi-eval-3669#7, head 930562820. The author ran a thorough (main-model) self-review before submitting; it reported no actionable defects.

- K4 widget-area race: **still missed**. Widgets still delete then reinsert with random ids; not named as a remaining gap, and the PR still says it closes the issue. The self-review missed it too.
- K5 Durable Object SQL atomicity: **resolved**. The new approach (stable slot ids with per-statement ON CONFLICT DO NOTHING and a (name, locale) claim) needs no batch or transaction and is correct on the D1 binding, DO SQL, SQLite and PostgreSQL; no atomicity is claimed.
- New: low. On PostgreSQL a losing concurrent run can throw on the parent foreign key (final data still correct; pre-existing).
- Grader verdict: request changes (scope: widgets, "Closes" should be "Refs").

#### Re-run 3686 (original PR 4226)

Fixture PR emdash-cms/emdash-bot-pi-eval-3686#7. The author ran a thorough self-review before submitting; it reported no actionable defects. The re-run took a different approach: a 30 s per-isolate TTL only, with no route-cache fill handling.

- K1 stale settings stored in route-cached pages in the reporter's configuration: **still present** (now with no fresh-read path at all). Worst case about 30 s plus the route cache maxAge. The PR body concedes the gap but still says it closes the issue.
- K2 tests exercise only the mechanism (mocked clocks, direct writes): **still present**.
- K3 hard expiry instead of stale-while-revalidate: **still present**; a database error at expiry now errors the page.
- Grader verdict: request changes.

#### Re-run 3018 (original PR 4201)

Fixture PR emdash-cms/emdash-bot-pi-eval-3018#7. The author's first thorough self-review found K11 (generated types omit caption); the author fixed it across the runtime schemas, zod-generator and every template's emdash-env.d.ts, and a second thorough review confirmed the fix. It then handed off because the fixture's CI cannot run EmDash's workflows (runner heap, no API access): an eval-environment artefact.

- K10 top-level caption vs existing meta.caption: **still present** (explicit "" contradicted by meta.caption; shape depends on how a value was written).
- K11 generated types and schemas omit caption: **fixed** (found by the self-review).
- K12 Edit asset overwrites a per-use caption: **still present**.
- K13 seed import/export ignore caption: **still present**.
- New, medium: writes by bare id, internal URL or {id, provider} still get no top-level caption (the reported symptom via another path).
- Grader verdict: request changes.

#### Re-run 3577 (original PR 4224)

Fixture PR emdash-cms/emdash-bot-pi-eval-3577#8 (re-run after the first attempt hit GitHub 429s fetching the repository). Three thorough self-reviews: the first found K6, the author added a coexistence rule; the second found two medium defects in it (a draft path row hiding a published code row; reference pagination), which the author fixed; the third was clean.

- K6 code-stamped rows unreachable: **partly fixed**. Entry and collection reads keep them via a SQL coexistence rule (path row first, then codes; status, deletion and pagination handled). Menus, taxonomies/terms and bylines still lose them; search, references and the REST/MCP handlers are unchanged. The changeset's "existing content does not need to be migrated" holds only for entries and collections.
- K7 string-only configs change case behaviour, undocumented: **still present**.
- New, critical (missed by all three self-reviews): object-locale sites can no longer build. The normalized i18n config gains `localeAliases`, which the strict migration-manifest schema rejects; the existing `tests/unit/migrations/config-loader.test.ts` passes on the base and fails on the PR, and the author never ran it.
- New, medium: search and getEmDashReferences still miss when given a code.
- Grader verdict: request changes.

#### Re-run 3592 (original PR 4221)

Fixture PR emdash-cms/emdash-bot-pi-eval-3592#7 (+22/-1, 3 files). The author ran a thorough self-review before submitting; it reported no actionable findings. The change is essentially the original: `quality?: ImageQuality` on EmDashImage props.

- K8 presets and fractional or out-of-range values break the Cloudflare image endpoint (integers 1-100 only): **still present**; the changeset again says presets are now typed.
- K9 quality ignored in most render paths and spread onto the raw `<img>` via `attrs`: **still present**.
- Improved: adds a type-test fixture (demos/simple/src/type-tests/image-quality.astro), covering the original's missing regression guard.
- Graded directly from the diff (small change).
