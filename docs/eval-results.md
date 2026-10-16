# Evaluation results, 15–16 October 2026

Runs on the staging Worker `emdash-bot-pi` against private single-commit snapshots of EmDash (`emdash-cms/emdash-bot-pi-eval-<case>`). Nothing touched `emdash-cms/emdash`. Each case was reviewed by the configured reviewer (an operator acting as `ascorbic`) to the same standard (comments and requested changes; approvals given with the operator's permission were later dismissed where GitHub allows it, which it does not on closed PRs), then its final head was graded with the validated private grader (the historical fix's tests, never shown to the author).

Costs are recorded by pi-ai from each response's usage and its price catalog. They are not AI Gateway billing (the gateway's logs are in another account). Anthropic charges 5x for requests over 100K prompt tokens, which pi-ai may not model, so Haiku's real cost on long cases is likely higher than recorded. Runs before the prompt-cache fix (`d84585b`) paid uncached rates and are not comparable.

## Summary

Final fixes, with cache-fixed runs only (costs are pi-ai estimates; minutes are label to settled, including review rounds and CI):

| Case                     | Sol 6.1 + Luna helpers                    | Claude Haiku 5.5 (+ Haiku helpers)            |
| ------------------------ | ----------------------------------------- | --------------------------------------------- |
| #4141 table paste        | 46/49*, $0.91, 14 min to PR               | 46/49*, $0.33, 29 min to PR                   |
| #4074 revision + crash   | 5/5, $1.08, 65 min                        | 5/5, $1.90, 84 min                            |
| #4070 D1 orphan row      | 2/2, $0.29, 9 min                         | 2/2, $0.06, 27 min                            |
| #4013 login help         | 12/12, $1.89, 77 min                      | 12/12, $0.07, 32 min                          |
| #4095 index readiness    | 26/31*, $0.75, 23 min                     | 26/31*, $0.34, 49 min                         |
| #4024 pending migrations | behaviour 2/2, unit 13/17*, $0.61, 15 min | behaviour 2/2, unit 13/17*, $0.09, 67 min     |
| **Total recorded**       | **$5.53**                                 | **$2.79** (likely more: long prompts cost 5x) |
| Approved on first pass   | 3 of 6 (#4070, #4095, #4024)              | 1 of 6 (#4024)                                |

\* Failures are hidden tests that encode the reference fix's API names or implementation choices; on each of these cases the final fix meets the issue's stated behaviour (details below).

Every final fix met the issue after review, and both models handled review, disagreement, CI diagnosis and the injected crash. The difference is first-pass judgement: Sol needed changes on two cases (#4141 alignment, #4013 a dropped hint), Haiku on five (one of them only a non-blocking suggestion), including two that missed the issue's central requirement on first pass (#4074 scope, #4095 writes still running without indexes). Sol was also the only model to use helpers unprompted. Haiku is roughly half the recorded cost overall but slower and needs a more careful reviewer. DeepSeek V4 Flash was dropped (it tested browser-mode suites under a self-written Node config and dismissed the resulting failures); Kimi K2.7 hit Workers AI capacity errors repeatedly.

Recommendation: GPT-6.1 Sol with GPT-5.6 Luna helpers as the default author; Haiku as the cheaper option where a maintainer reviews closely. Runs ran up to three at a time on separate eval repos and providers from 23:49 onwards, which affects timings slightly.

## Graders

| Case                     | Hidden tests                                                        | Starting commit | Reference |
| ------------------------ | ------------------------------------------------------------------- | --------------- | --------- |
| #4141 table paste        | `table-cell-safety.test.tsx` (Chromium)                             | 3 of 49 fail    | 49 pass   |
| #4074 redirect revision  | `slug-change-redirect-dialect.test.ts`                              | 3 of 5 fail     | 5 pass    |
| #4070 D1 orphan field    | `create-field-column-limit-d1.test.ts` (workerd)                    | 2 of 2 fail     | 2 pass    |
| #4013 login help         | `LoginPage.test.tsx` (Chromium)                                     | 2 of 12 fail    | 12 pass   |
| #4095 plugin indexes     | `storage-indexes.test.ts`, `plugin-storage-index-readiness.test.ts` | 5 of 31 fail    | 31 pass   |
| #4024 pending migrations | `pending-migration-listings.test.ts`, `db-errors.test.ts`           | 6 of 19 fail    | 19 pass   |

Validation now requires the starting commit to pass setup and fail its tests; the first #4070 "valid" result had failed during install. Three grader commands named a Vitest config that excluded their tests and were corrected.

## Results by case

### #4141 table paste (fix)

| Model                               | First pass                                   | After one review                | Hidden tests (final) | Recorded cost          | To first PR |
| ----------------------------------- | -------------------------------------------- | ------------------------------- | -------------------- | ---------------------- | ----------- |
| DeepSeek V4 Flash                   | good; unscoped details                       | not finished (old 4M token cap) | 48/49 (first pass)   | $2.51 (no cache)       | ~25 min     |
| GPT-5.6 Luna                        | stripped alignment from every paste          | fixed all points                | 48/49                | n/a (case object lost) | ~12 min     |
| Claude Haiku 5.5                    | strong; real paste tests                     | fixed all points                | 46/49                | $1.91 (cache bug)      | ~30 min     |
| GPT-6.1 Sol + Luna helpers          | strongest; correct width handling unprompted | fixed all points                | 46/49                | $0.91                  | ~14 min     |
| Haiku + Haiku helpers (cache fixed) | alignment moved to cell unprompted           | took a non-blocking suggestion  | 46/49                | $0.33                  | ~29 min     |

48 vs 46 is one design choice: the hidden tests call `handlePaste` with raw slices; fixes that repair only in `transformPasted` (every real paste goes through it) fail three of them, and are the only ones that still reject over-long width arrays. On real behaviour Sol's and Haiku's final fixes are the best.

### #4074 redirect revision with injected crash

The case starts from the old bot's incomplete PR and review, and destroys the sandbox right after the revised candidate is sealed (where the old bot published a stale candidate).

| Model                 | Review points addressed                                                                                   | Recovery                        | Hidden tests | Recorded cost                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------ | ------------------------------------------------- |
| Sol + Luna helpers    | both in the first revision, plus a cache race; took the nit too                                           | published the revised candidate | 5/5          | $1.08 (65 min)                                    |
| Haiku + Haiku helpers | fixed the seed path, disputed the transaction point as pre-existing; accepted the correction in round two | published the revised candidate | 5/5          | $1.90 (84 min; prompts over 100K, so likely more) |

The seeded PR is opened by the controller as the reviewer, so it cannot be approved or have changes requested on it; reviews went in as comments and these cases cannot reach "ready".

### #4070 D1 orphaned field row

| Model                 | Review                                                                                                                    | Hidden tests | Outcome                                                                                  | Recorded cost  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- | -------------- |
| Sol + Luna helpers    | approved first pass: cleanup only on a failed column add without a transaction                                            | 2/2          | ready for human, reporter asked to confirm on the issue                                  | $0.29 (9 min)  |
| Haiku + Haiku helpers | first pass undid the field on any later failure and dropped columns on transactional databases; narrowed exactly as asked | 2/2          | needs human: handed off to report the eval repo's CI environment (runner OOM, token 403) | $0.06 (27 min) |

### #4013 login help text

| Model                 | Review                                                                                                                                                                                                                                                    | Hidden tests | Outcome         | Recorded cost  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------- | -------------- |
| Haiku + Haiku helpers | added `loginHelp` (string); then string-or-component, docs and tests; disputed translating the Atmosphere hint with a correct technical reason (the Lingui macro only runs on admin source), which the reviewer accepted                                  | 12/12        | ready for human | $0.07 (32 min) |
| Sol + Luna helpers    | first pass only the neutral fallback (lost the Atmosphere hint); then `loginHelp` string-or-component, docs, tests, and a translated Atmosphere hint via runtime `<Trans id message>` plus extraction config; then made `@lingui/react` a peer dependency | 12/12        | ready for human | $1.89 (77 min) |

### #4095 plugin storage-index readiness

| Model                 | Review                                                                                                                                     | Hidden tests | Outcome         | Recorded cost  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | --------------- | -------------- |
| Sol + Luna helpers    | approved first pass: 503 before state-changing routes until a plugin's indexes exist, per-plugin success-only cache, reads untouched, docs | 26/31        | ready for human | $0.75 (23 min) |
| Haiku + Haiku helpers | first pass still let writes run without indexes and tracked readiness globally; fixed both in one revision                                 | 26/31        | ready for human | $0.34 (49 min) |

Both final fixes meet the report's four expected behaviours. All five hidden failures in both runs are naming the author could not have seen: the reference returns `{ ok }` (Sol returned a boolean, Haiku `{ complete }`), uses the code `STORAGE_INDEXES_NOT_READY`, and exposes `ensureStorageIndexesSynced`. This grader cannot distinguish a correct alternative from a wrong one.

### #4024 listings empty while migrations are pending

| Model                 | Review                                                                                                                                                                  | Hidden tests              | Outcome         | Recorded cost  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------- | -------------- |
| Haiku + Haiku helpers | approved first pass (missing relation column tolerated in field-map; loader only blames the caller for columns the caller named); tightened a regex on an optional note | behaviour 2/2; unit 13/17 | ready for human | $0.09 (67 min) |
| Sol + Luna helpers    | approved first pass: only an unqualified, caller-named, non-system column counts as a bad filter; field-map tolerates a missing relation column                         | behaviour 2/2; unit 13/17 | ready for human | $0.61 (15 min) |

Both runs' four unit failures call `isMissingSystemColumnError`, a helper only the reference fix defines.

## Findings and changes made during the runs

Everything below is committed on `implement-plan` and deployed to `emdash-bot-pi`.

**Bot**

- Prompt caching was broken for every model: the system prompt carried live case state (budgets, candidate, head), so it changed on every request and invalidated the cache. Live state now comes from `case_status`; a test pins the prompt to one change per run. Haiku's #4141 cost fell from $1.91 to $0.33.
- A failed model call (Workers AI capacity, a binding returning nothing) left the case "working" forever. It now records the error, hands off with it, and resume or a comment retries.
- `delegate` tool: a durable, task-owned helper conversation on a cheaper model (Pi Durable's subagent recipe). Only Sol delegated unprompted; DeepSeek and Haiku with same-model helpers never did.
- `ci_log` tool: checks messages list each failure's check run id, and the author or a helper reads the tail of that job's log. Before it, authors asked maintainers for logs and handed off.
- Failing checks reach the author batched, one message per CI round (EmDash's CI fails many checks at once); skipped checks never do. CI conclusions go in the work plan, with a reply only when a maintainer must act.
- Status check run on the PR head ("in progress" only while the author works); progress comment collapses evidence into `<details>`; "waiting for a reply" when idle without a change; auto-intake progress comment only once the author starts work.
- Unavailable cases (a Durable Object whose storage keeps failing) are reported once on the issue and restart as a fresh case on the next intake.
- AI disclosure names the case's primary model; staging App renamed `emdash-autofix-staging` (production default `emdash-autofix`).
- Budgets raised to 20M tokens and 100 runs as runaway guards. Repositories can set their own required checks (eval repos require none, so approval can reach "ready").
- Sandbox: Node heap ceiling 12 GB (EmDash's core build failed at the default and at 6 GB); skill notes that `lint:json` won't run there.

**Evals**

- Graders validated for all six cases; validation requires the starting commit to fail its tests, not setup.
- Grader installs use their own copied pnpm store and retry once: EmDash's lockfile installs several `workerd` versions whose install scripts occasionally race. Concurrent grades still failed once; grade one at a time.
- `--model` and `--child-model` per attempt.

**Observations**

- Hidden tests often encode the reference fix's API names (#4095, #4024 unit tests, #4141's raw-slice tests). Grades need reading, not counting; behavioural tests are the reliable signal.
- Models acted on optional notes left with an approval, which needs a fresh approval each time. Worth deciding whether optional notes should wait for a follow-up.
- Eval repos' CI cannot pass (no upstream secrets, the runner runs out of memory building core). Authors diagnosed this correctly through `ci_log`; Haiku on #4070 handed off over it.
- Both models disagreed with a review point once, with reasons: Haiku was wrong on #4074 (scope of its own PR) and right on #4013 (Lingui extraction), and accepted the outcome either way.

**Needs a human**

- Revoke the npm token printed by mistake from `~/.npmrc` during the run (https://www.npmjs.com/settings/~/tokens).
- Luna's first #4141 case object is broken by a Durable Objects storage error (references `od1g8ge38spcmgkg4l7qj1t2`, `uvd6005sjmcgdu6c4d4jahil`, `lf8sfcq00d7fah7edgdjoid7`, `l4ku82nem43f58a93gfbbu61`).
- AI Gateway billing is in another account; recorded costs are pi-ai's estimates.
