# Staging and human testing

The staging Worker is `emdash-bot-pi` at https://emdash-bot-pi.emdash-cms.workers.dev, on the EmDash CMS Cloudflare account. It never targets `emdash-cms/emdash`; it admits the private fixture `emdash-cms/emdash-bot-pi-fixture` and disposable `emdash-cms/emdash-bot-pi-eval-*` repositories.

## What already works without GitHub credentials

- Webhook intake from the fixture repository (a repository webhook is configured).
- `pnpm ops smoke model`: one read-only author-model turn through AI Gateway `default`.
- `pnpm ops smoke sandbox --repo <public repo>`: container start, read-only fetch through the egress gate, blocked hosts.
- `pnpm ops dry-run <eval-case>`: the real author on a public repository at a pinned commit, with publication disabled (see below).

## One-time setup (an emdash-cms owner)

The bot needs a GitHub App to read the fixture, push branches and open PRs.

1. `node --experimental-strip-types scripts/create-github-app.ts` and follow the browser prompt. It writes the App ID, private key and webhook secret to `.env.staging`.
2. Set `botLogin` in `profiles/staging.json` to `<app-slug>[bot]`.
3. Install the App on `emdash-cms/emdash-bot-pi-fixture` (and the `emdash-bot-pi-eval-*` repositories when running evals).
4. Delete any repository webhook on the fixture so the App's webhook is the only source (already done for the current fixture).
5. `node --experimental-strip-types scripts/create-github-app.ts --installation`, then `pnpm run deploy:staging`.
6. `pnpm ops smoke model` to confirm the deployment.

`.env.staging` also holds `OPERATOR_TOKEN`, used by `pnpm ops` and `pnpm evals`. Share it only through a secret store.

## Manual test script

On `emdash-cms/emdash-bot-pi-fixture` (`greet.js` lacks punctuation; `node test.js` fails). Staging has auto-intake on.

1. Open an issue describing the bug. The author decides to take it on: expect a progress comment with its plan on the issue, then a pull request from `emdash-bot/issue-<n>`, ready for review, with the template filled in and an AI disclosure. The progress comment moves to the pull request and the issue keeps a pointer.
2. Open an issue that is a feature request. Expect a short decline message and nothing else.
3. Comment on the pull request (no mention needed) with a question, or leave an inline review comment as a configured reviewer (`emdashbot[bot]` or `ascorbic` in staging). Expect a reply in the conversation or thread. Ask for a change and expect a new commit on the same branch.
4. Approve as the configured reviewer once satisfied. With green CI on that head, expect "Ready for human review", and expect the author to ask the reporter on the issue to confirm the fix. Reply as the reporter that it works: expect thanks and "Reporter confirmation: confirmed" in the progress comment.
5. Push a commit to the bot's branch yourself, then ask for another change. Expect your commit preserved; on a conflict the author rebuilds its change on top.
6. Remove the label (or for an auto-intake issue, apply and remove it). Expect cancellation and no further tool use or publication.

Inspect anything with `pnpm ops inspect <case-id>` and export evidence, including the full transcript, with `pnpm ops evidence <case-id> --out case.json`. Case IDs are `<repo-id>-issue-<issue-id>` or `<repo-id>-pr-<pr-id>`.

## Fault injection (staging only)

Arm a boundary before or during a case: `pnpm ops fault <case-id> <boundary>`. Boundaries: `during-tool`, `after-checkpoint-upload`, `after-checkpoint-commit`, `after-candidate-sealed`, `after-commit-created`, `after-ref-update`, `after-pr-created`, `report-failure`. Resets use `ctx.abort()` after making the disarm durable.

## Dry runs

`pnpm ops dry-run 4141` admits a case for the upstream repository at the case's starting commit with publication disabled; the case hands off with the sealed candidate. Export the patch with `pnpm ops artifact <case-id> <candidate-id> --out candidate.patch`. Use this to measure preparation, checkpoint cost and author quality before GitHub credentials exist. It is not an evaluation score.

## Evaluations

See the controller help in `evals/bin/evals.ts`. Before scoring a historical case, validate its grader: `pnpm evals validate --case 4141` (needs Node 24 and pnpm locally; the grader installs EmDash inside a temporary checkout with a credential-free environment). Then `pnpm evals run --case 4141`, `pnpm evals run --suite initial-six`, `pnpm evals resume --attempt <id>` and `pnpm evals report`. Results are written to the ignored `evals/results/`; fill in the `human` fields of each `summary.json` after blind review of `review-queue.diff`.
