# Plan: Opus as author, Sol as reviewer, against the reverse

The October evals compared Sol with Haiku as the author and only ever used Opus as the reviewer. This plan tests whether swapping the families helps: Claude as author (Opus 5.5, with Haiku 5.5 helpers) reviewed by Sol, against Sol as author (with Luna helpers) reviewed by Opus. It also re-baselines on the current code, which has changed in 16 commits to `src/` since the last full runs.

## Models (checked 12 November 2026)

| Role                   | Configured now    | Latest available   | Notes                                                                             |
| ---------------------- | ----------------- | ------------------ | --------------------------------------------------------------------------------- |
| Author                 | `gpt-6.1-sol`     | `gpt-6.1-sol`      | current                                                                           |
| Helpers (`childModel`) | `gpt-5.6-luna`    | `gpt-6-luna`       | **one version behind**; also cheaper ($0.10 / $0.50 against $0.20 / $1.20 per 1M) |
| Review                 | `claude-opus-5-5` | `claude-opus-5-5`  | current; Fable 5.2 is above Opus but not in pi-ai's catalog                       |
| Haiku                  | not configured    | `claude-haiku-5-5` | current                                                                           |

Both profiles (`profiles/staging.json`, `profiles/production.json`) use the same models. The installed pi-ai (1.2.0) lists every model above and models the higher prices above 100K input tokens (Haiku) and 272K (Sol, Luna). pi-ai 1.5.2 adds no newer ids for these families, so the plan does not upgrade it. Upgrading would change the runtime during the comparison.

## Arms

All arms use the same `thinkingLevel` (`medium`), one self-reviewer and the default budgets.

| Arm                   | Author            | Helpers            | Review model      |
| --------------------- | ----------------- | ------------------ | ----------------- |
| **C** (Claude author) | `claude-opus-5-5` | `claude-haiku-5-5` | `gpt-6.1-sol`     |
| **S** (Sol author)    | `gpt-6.1-sol`     | `gpt-6-luna`       | `claude-opus-5-5` |

Arm S is the production setup, but with the newer Luna. Thorough delegations run on the author's own model, so they run on Opus in C and Sol in S. All model ids use the `cloudflare-ai-gateway:` provider.

## Cases

The six cases with validated private graders: 4141, 4074 (with its injected crash), 4070, 4013, 4095 and 4024. The other five cases have no hidden tests, so they are left out.

Each case runs once in each arm (12 attempts). A case gets a second run in both arms when its two results differ in grader result, in whether the first pass needed changes, or in final outcome. Expect 16 to 20 attempts in total.

## Changes needed before running

1. **Review-model override for full attempts.** `setFixture` (`src/cases/case-do.ts`) and the `/ops/cases/:id/fixture` route (`src/index.ts`) accept `model` and `childModel` only. `reviewModel()` already reads `fixtureReviewModel`, which today only dry runs set. Accept `reviewModel` in both places.
2. **`--review-model` in the eval CLI.** Add it to `evals/bin/evals.ts` and `newAttempt`/`AttemptState` in `evals/controller/attempt.ts`, and send it with the fixture call next to `childModel`.
3. **Cost in the summary.** Copy `evidence.usageByModel` into `summary.json` next to `tokens`, and record `model`, `childModel` and `reviewModel` in it.
4. **Deploy staging** (`pnpm run deploy:staging`) after `pnpm check` and `pnpm test` pass.

Example run:

```bash
pnpm evals run --case 4070 --model cloudflare-ai-gateway:claude-opus-5-5 --child-model cloudflare-ai-gateway:claude-haiku-5-5 --review-model cloudflare-ai-gateway:gpt-6.1-sol
```

## Procedure

- Run at most three attempts at a time, each on its own eval repository, as in October. Interleave the arms so neither arm runs mostly at a busy time.
- The operator reviews each PR as `ascorbic`, to the same standard as October. Review from the anonymized diff without knowing the arm, and take review rounds in the order PRs arrive.
- Grade each final head with its case's private grader.
- Stop an attempt at its case budget (240 minutes) and record it as timed out. Don't rerun it unless the cause was infrastructure rather than the model (for example a provider capacity error or a sandbox hang).

## Measures

From `summary.json` and the evidence, for each attempt:

- **Quality:** hidden tests passed (first published head and final head); whether the first pass needed changes, and which of the issue's requirements it missed; open findings at settle; final outcome.
- **Self-review:** findings the pre-submit reviewer raised, and how many the human reviewer then also raised or would have. This shows whether Sol is a useful reviewer for Opus's work, and the reverse.
- **Cost:** recorded dollars per model and in total; tokens.
- **Time:** to first PR, and from label to settle.
- **Human effort:** review rounds, and repair minutes (filled in by the reviewer).

Compare the arms per case, and in total over the cases both arms finished. Report cost per accepted fix, not per attempt.

## Cost and time estimate

Arm S cost $0.29 to $1.89 per case in October. Opus is 2× Sol per token at list price and 2× to 3× in what we recorded, so arm C should cost about $1 to $6 per case. With 16 to 20 attempts, expect roughly **$30 to $70** in total. The main cost is the human reviewer's time: one review pass, and usually a second, for each PR.

## Decision

- If C is clearly better in first-pass quality, at no more than about 3× S's cost per accepted fix, trial C as the author on staging.
- If the two arms are about level, keep S, which is cheaper.
- Apart from the result, move the helper model to `gpt-6-luna` in both profiles once arm S shows no regressions. That change goes to production as a separate, explicit change.
