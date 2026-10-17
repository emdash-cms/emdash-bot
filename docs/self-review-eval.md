# Self-review evaluation (2026-10-17)

Does the author's pre-submit adversarial self-review catch what it missed on its own pull requests? Raw results (transcripts, evidence) are in `evals/results/review-replay/` and `evals/results/self-review-reruns/` (not committed); the answer key is `evals/self-review-answer-key.md`.

## Step 1: replaying the self-review

The author's pre-submit self-review, replayed as a staging dry run (GPT-6.1 Sol, the author's own model) on a private snapshot of each pull request's head, with the issue, the diff, the description and the adversarial review skill from upstream PR 4227. Two runs per pull request. Scored against `evals/self-review-answer-key.md`.

| PR   | Key finding                                            | Run 1                            | Run 2                          |
| ---- | ------------------------------------------------------ | -------------------------------- | ------------------------------ |
| 4226 | K1 route-cache fresh read gated on an object cache     | found                            | found                          |
| 4226 | K2 tests set the flag directly                         | not reported                     | not reported                   |
| 4226 | K3 hard expiry, not stale-while-revalidate             | not reported                     | not reported                   |
| 4225 | K4 widget-area race                                    | missed ("no actionable defects") | missed                         |
| 4225 | K5 not atomic on Durable Object SQL                    | missed                           | missed                         |
| 4224 | K6 code-stamped rows unreachable; "no migration" false | found                            | found (reproduced with SQLite) |
| 4224 | K7 case behaviour for string-only configs              | not reported                     | not reported                   |
| 4221 | K8 quality values break the Cloudflare image endpoint  | missed ("no defects")            | missed; judged presets correct |
| 4221 | K9 quality ignored in most render paths                | missed                           | missed                         |
| 4201 | K10 conflicts with `meta.caption`                      | not reported                     | not reported                   |
| 4201 | K11 generated types omit `caption`                     | found                            | found                          |
| 4201 | K12 Edit asset overwrites the per-use caption          | not reported                     | not reported                   |
| 4201 | K13 seed and export paths                              | not reported                     | not reported                   |

Headline findings: 3 of 5 pull requests (4226, 4224, 4201), consistently across both runs. Missed in 2 of 5 (4225, 4221), with both runs reporting the change as sound.

Caveats: the replay brief asked for findings in a final message, but in 9 of 10 runs the model recorded only a summary in its work plan before handing off, so detailed findings below the headline may be undercounted (K2, K3, K7, K10, K12, K13 are "not reported", not proven missed). In the bot's real flow the review comes back as a delegate's text report, so this capture problem does not apply there.

The misses share a shape: K4 and K5 need the reviewer to look beyond the changed code for the same defect (other seed steps, other storage backends), and K8 and K9 need it to trace the value into another package (the Cloudflare image endpoint) and other render branches. The skill names both ("Scope", "Trace concrete inputs"), but the reviewer did not do either here.

## Step 2: re-running the bot end to end

The bot (staging, GPT-6.1 Sol with Luna helpers, deployed at a2bc67a) re-ran five issues from scratch in private fixtures with the upstream PR 4227 review skill overlaid. Every case ran a thorough (main-model) self-review before submitting. Each resulting pull request was graded by an independent adversarial review against `evals/self-review-answer-key.md`. Per-case notes are beside this file.

| Issue (orig. PR) | Self-review                                                      | Key findings                                                                | New defects                                                                                         |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 3669 (4225)      | ran; "no defects"                                                | K5 resolved (approach needs no atomicity); K4 widgets still missed          | low: PostgreSQL FK throw for a losing run (pre-existing)                                            |
| 3686 (4226)      | ran; "no defects"                                                | K1, K2, K3 all still present (TTL only; the gap is admitted in the PR body) | none                                                                                                |
| 3018 (4201)      | found K11, then fixed and re-verified                            | K11 fixed; K10, K12, K13 still present                                      | medium: id-only writes still lack top-level caption                                                 |
| 3577 (4224)      | found K6 and two follow-on defects, fixed them over three rounds | K6 partly fixed (entries and collections); K7 still present                 | **critical**: build breaks for object-locale sites (strict manifest schema; an existing test fails) |
| 3592 (4221)      | ran; "no defects"                                                | K8, K9 still present                                                        | none                                                                                                |

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

## Reviewer model comparison

The same replay (a staging dry run on a private snapshot of each pull request's head, with the issue, diff, description and the PR 4227 review skill), with the reviewing model varied and findings captured in full through `reply`. Costs are pi-ai's recorded usage costs.

### Round 1: shortlist on the two pull requests Sol missed, plus a clean control

PRs: 4225 (K4 widget race, K5 DO SQL atomicity), 4221 (K8 Cloudflare endpoint, K9 ignored in render paths / leaks onto img), 4220 (clean control: false alarms). One run each. Baseline Sol (step 1): missed K4, K5, K8, K9 in both runs.

| Model             | PR             | Findings                                                                                                                                                                                                                                                       | Time   | Tokens | Cost  |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ | ----- |
| DeepSeek V4 Pro   | 4221           | K9 found (both halves, rated low, non-blocking); K8 missed (accepted presets)                                                                                                                                                                                  | 23 min | 2.64M  | $0.34 |
| DeepSeek V4 Pro   | 4225           | K4 missed (named the collections race only); K5 missed (judged atomic); new uncertain point: D1 per-batch statement cap unbudgeted                                                                                                                             | 26 min | 3.50M  | $0.83 |
| Claude Opus 5.5   | 4221           | K9 found (rated medium, clear fix; also flags misleading doc comment and changeset); K8 missed (accepted presets as Astro's type); one harness-caused false point (issue number)                                                                               | 3 min  | 0.18M  | $0.26 |
| DeepSeek V4 Pro   | 4220 (control) | Over-severity false alarm: rated "High" that D1 rejects the correlated parameterised pragma_table_info (the reference rated it speculative/low; the PR's workerd D1 test passes, though that is Miniflare emulation, a fair point); would block a mergeable PR | 30 min | 3.94M  | $0.78 |
| Claude Sonnet 5.5 | 4221           | K9 half (leak onto raw img, rated low/medium; missed the ignored cross-origin path); K8 missed; same harness-caused issue-number point                                                                                                                         | 3 min  | 0.13M  | $0.10 |
| Claude Opus 5.5   | 4225           | **K4 found** (medium, exact location, scenario and fix); K5 partly (noted the DO SQL fallback is not atomic, but dismissed it as not the reporter's path); same harness-caused issue-number point                                                              | 6 min  | 0.75M  | $0.58 |
| Claude Haiku 5.5  | 4221           | K9 half (leak onto img, low; noted quality is ignored remotely but judged that correct, docs only); K8 missed; same harness-caused issue-number point                                                                                                          | 2 min  | 0.31M  | $0.01 |
| Claude Sonnet 5.5 | 4225           | K4 missed (flagged the collections-step race and missing database-level claim instead); K5 missed; useful scope points on "Closes"; same harness-caused issue-number point                                                                                     | 3 min  | 0.10M  | $0.11 |
| Claude Opus 5.5   | 4220 (control) | Correct: no significant defects; D1 pragma risk kept as low residual (matches the reference); noted getSuggestions follow-up and ranking behaviour change; only the harness-caused prose point                                                                 | 9 min  | 0.58M  | $0.55 |
| Claude Haiku 5.5  | 4225           | K4 missed; K5 missed (raised the non-batch fallback only as unverified, without naming DO SQL); believed the checkout was at the base commit (it was the head) and reviewed from the diff alone; reasonable scope points                                       | 3 min  | 0.25M  | $0.01 |
| Claude Sonnet 5.5 | 4220 (control) | Correct: no high or critical defects; low notes on the ranking source change (matches the reference's nit), discovery set, and a new error path; no false alarm                                                                                                | 2 min  | 0.15M  | $0.16 |
| Claude Haiku 5.5  | 4220 (control) | Correct: no confirmed defect; D1 compatibility as medium but explicitly unverified (calibrated); same harness-caused issue-number point                                                                                                                        | 3 min  | 0.60M  | $0.02 |

## Round 1 summary

K4, K5, K8, K9 are the four key findings on the two PRs where Sol (the author's model) missed everything in step 1. Half credit for a finding caught only in part or dismissed.

| Model                  | Key findings (of 4)       | Control 4220              | Time per review | Cost (3 reviews) |
| ---------------------- | ------------------------- | ------------------------- | --------------- | ---------------- |
| Sol (baseline, step 1) | 0                         | not run                   | 4-8 min         | not recorded     |
| **Claude Opus 5.5**    | **2.5** (K4, K9, half K5) | correct                   | 3-9 min         | $1.39            |
| DeepSeek V4 Pro        | 1 (K9, rated low)         | over-severity false alarm | 23-30 min       | $1.95            |
| Claude Sonnet 5.5      | 0.5 (half K9)             | correct                   | 2-3 min         | $0.37            |
| Claude Haiku 5.5       | 0.5 (half K9)             | correct                   | 2-3 min         | $0.04            |

No model found K8 (quality values breaking the Cloudflare image endpoint): every one accepted Astro's preset type without tracing into EmDash's own endpoint. All four made a harness-caused point about the issue number (the dry run labels the task with the pull request's number), not counted.

Opus is the only candidate that clearly beats Sol on these cases, including the widget race nothing else found, with no false alarm, at about $0.46 a review. It goes to round 2.

### Round 2: Claude Opus 5.5 on every pull request

Baseline Sol from step 1 (two runs): 4226 K1 only; 4224 K6 only; 4201 K11 only; 4225 and 4221 nothing.

| PR             | Findings                                                                                                                                                                                                                                             | Time  | Tokens | Cost  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ----- |
| 4201           | K11 found (medium); K12 found (low, exact handler); K10 missed; K13 missed; also found the reference's backfill nit (complete stored values never filled)                                                                                            | 5 min | 0.64M  | $0.51 |
| 4226           | K1 found (High, exact gate, reporter scenario, false description claim); K2 found (names the test that hides the gap); K3 missed; also the hot-path cost note (reference finding 4)                                                                  | 3 min | 0.21M  | $0.29 |
| 4224           | K6 found (medium-high, exact read paths, false "no migration" claim) plus a new point: re-seeding duplicates code-stamped rows; K7 missed                                                                                                            | 6 min | 1.41M  | $0.86 |
| 4219 (control) | Correct: code fine, no sibling dialog left; found the missing screenshots (the reference's should-fix) and that attach_screenshot exists (true now, not when the original PR was written); missed the size="sm" test nit; no false alarm on the code | 5 min | 0.66M  | $0.47 |
| 4221 (repeat)  | K9 found again (medium/low: ignored on the getImage path and leaking onto img, comment wrong for that path); K8 missed again (accepted ImageQuality); consistent with run 1                                                                          | 3 min | 0.11M  | $0.22 |
| 4225 (repeat)  | K4 found again (same location and scenario, plus concurrent area creation throwing on the unique name); K5 partly again (D1 REST dialect not atomic, not DO SQL); new point: the D1 overlap test does not exercise atomicity                         | 7 min | 0.89M  | $0.67 |

## Round 2 summary: Opus against Sol over all thirteen key findings

| PR                  | Sol (step 1, best of two) | Opus 5.5                                                               |
| ------------------- | ------------------------- | ---------------------------------------------------------------------- |
| 4226                | K1 (1/3)                  | K1, K2 (2/3)                                                           |
| 4225                | none (0/2)                | K4 both runs, half K5 both runs (1.5/2)                                |
| 4224                | K6 (1/2)                  | K6, plus re-seed duplication (1/2)                                     |
| 4221                | none (0/2)                | K9 both runs (1/2)                                                     |
| 4201                | K11 (1/4)                 | K11, K12 (2/4)                                                         |
| **Total**           | **3/13**                  | **7.5/13**                                                             |
| Controls 4220, 4219 | not run                   | both correct, no false alarm on code; found 4219's missing screenshots |
| Cost per review     | $0.19 average             | $0.49 average ($0.22 to $0.86)                                         |
| Time per review     | 4-8 min                   | 3-9 min                                                                |

Sol's detail findings may be undercounted (step 1 captured mostly summaries); Opus's were captured in full via reply. Still missed by every model: K3 (hard expiry), K5 in full (Durable Object SQL), K7 (string-config case change), K8 (Cloudflare image endpoint), K10 (meta.caption), K13 (seed and export).

### Conclusion

Claude Opus 5.5 is the clear choice for the adversarial review: about 2.5 times the key findings of the author's own model (7.5 of 13 against 3), consistent across repeat runs, with no false alarms on the two clean controls, at about 2.6 times the cost per review ($0.49 against $0.19), a few cents per pull request in practice. A different model family reviewing the author's work catches more than the author's own model. DeepSeek V4 Pro was slow (23-30 min a review) and raised an over-severity false alarm; Sonnet and Haiku 5.5 were cheap and calibrated but barely better than Sol. No model traced the Cloudflare image endpoint (K8), and several cross-cutting findings (K3, K5 in full, K7, K10, K13) remain out of reach of any single review, so a maintainer's review stays essential.

## Opus as review model: end-to-end re-runs

With `reviewModel` set to Claude Opus 5.5 on staging (the author still Sol, the review a `thorough` delegation the author briefed itself), cases 3686 and 3669 were re-run from scratch.

| Case | Self-review                                                                                                   | Grade                           | Key findings                                                        | Author cost and time                              |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| 3686 | Found K1; a second review caught a prefetch regression in the fix; a third was clean                          | approve with minor reservations | K1 fixed, K2 partly, K3 still present                               | $0.91, 48 min model time                          |
| 3669 | One review of "the staged diff"; tests verified against base, 703 nearby tests; raised only the unchanged 409 | request changes (mild)          | K4 still present, K5 avoided, K15 partly, K16 present but disclosed | $1.44, 66 min model time (about 2.5 h wall clock) |

Compared with the original pull requests (#4226 blocked on K1; #4225 with K4 and K5) and the Sol-review re-runs, both improved. But on 3669 the end-to-end reviewer missed K4, which the Opus replay of #4225 found in both runs. The difference is the brief: the replay asked whether the change fixes the report, while the author asked its reviewer to check its own diff, and the reviewer checked the menus it was pointed at.

That led to the `review` tool: trusted code briefs the reviewers from the original request and the whole change, the author supplies only the pull request text it will submit (checked as claims), and two reviewers run independently. Its re-runs are the next measurement.
