# EmDash bot (Pi)

An EmDash issue and pull-request author service built on Pi Durable, hosted in Cloudflare Durable Objects through `PiHarness`. It preserves completed source changes through interruptions, publishes only saved candidates through trusted code, carries review findings across revisions, and reports readiness from exact-head evidence. Human approval is always required to merge.

[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) is the design and records the implementation status of each slice. [docs/staging.md](docs/staging.md) is the guide for human testing on the staging Worker.

## How it works

The bot keeps as little machinery as possible on top of Pi. Trusted code decides who may talk to the author, keeps source safe, publishes, and enforces budgets. Everything else is the author's judgement.

- **Intake.** A maintainer applies the `emdash-bot` label to an issue or same-repository PR, or assigns a configured machine user; removing it cancels. With `autoIntake` on, every newly opened issue is admitted too, except issues maintainers open (they assign the bot explicitly; `autoIntakeMaintainers` lifts this, for staging tests). Clef (`@cf/cloudflare/clef`) triages it first: likely spam is declined silently, feature requests, questions and large changes are declined with a short message, and only clear, small bugs or tasks reach the author (with a "needs information" note when the report is not actionable). The author can still `decline`. Thresholds are `triage` in the config; a Clef failure declines silently. Webhooks are verified, allowlisted and recorded durably by `RepositoryDO`, then forwarded to one `CaseDO` per issue or PR.
- **Messages to the author.** Every admitted event becomes one message to Pi, labelled with who sent it and how their authority was established: the assignment, comments from maintainers, the configured reviewer or the reporter, reviews with their inline comments, maintainer pushes, failing checks, and the bot's own milestones (published, ready for human review). Pi's inbox queues messages that arrive mid-run. There are no rounds or state machine.
- **Source and publication.** Pi's read, write, edit and bash run in a Cloudflare Sandbox container through a Pi `ExecutionEnv` adapter. Every source mutation is checkpointed to R2 and committed in the case's SQLite before the tool returns. `submit_candidate` seals a checkpoint; trusted code publishes it through GitHub's Git Data API after materializing it in a fresh sandbox and checking the tree hash, with durable intents and reconciliation for lost responses. Pull requests open ready for review.
- **Talking.** The author answers with `reply` (on the PR, in a review thread, or on the issue), keeps a short plan with `update_work_plan`, and records the reporter's confirmation with evidence. The bot keeps one progress comment, with the plan and the evidence-based status, on the issue until the PR opens and on the PR after. On the PR head it also keeps an `EmDash bot` check run: in progress while the author works, `success` when ready for human review, otherwise `neutral` (never `failure`; readiness comes from required checks and review). This needs the App's `checks: write` permission; without it only the comment is posted. The bot also labels the issue and its PR so people can find work: `triage/awaiting-reporter` (ready, reporter not yet confirmed), `triage/verified` (reporter confirmed), `triage/skipped` (declined) and `triage/failed` (model or platform failure), plus `area/*` labels from the PR's changed paths (`areaLabels` per repository). Labels are derived from recorded evidence and never read back.
- **Readiness.** Status is computed from evidence and the live PR: required checks on the exact head, the configured reviewer's latest review of that head (or of the commit a format-only push sits on) being an approval or clean, and mergeability. It reports; it never gates the author. Human approval is always required to merge.

## Development

Use Node 24 and pnpm (pinned in `package.json`). Production builds and deploys also build the sandbox image and need Docker; tests do not.

```sh
pnpm install --frozen-lockfile
pnpm check              # format, lint and type check
pnpm test               # build, then unit, recovery and revision suites in Miniflare
pnpm evals recovery --target local
```

The integration tests run the built Worker in Miniflare from Node, with a fake GitHub (real bare git repositories behind Miniflare's outbound service) and a fake sandbox (real git in temporary directories). A scripted author, registered only outside production, drives deterministic runs and fault injection.

## Layout

| Path                    | Contents                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/cases/`            | `CaseDO` (Pi host, admission, rounds, status), `RepositoryDO` (routing and delivery inbox), case store |
| `src/runtime/`          | Model wiring (Workers AI and AI Gateway) and the scripted author                                       |
| `src/tools/`            | Case-scoped author tools wrapping Pi's built-ins with checkpoints                                      |
| `src/source/`           | Patch validation and trusted git operations                                                            |
| `src/execution/`        | Sandbox Durable Object, egress gate and Pi `ExecutionEnv` adapter                                      |
| `src/github/`           | Webhooks, auth, publisher, reviewer adapter and check classification                                   |
| `src/reports/`          | Deterministic status and PR text                                                                       |
| `evals/`                | Evaluation controller, fixture manifests and private graders                                           |
| `scripts/`              | Operator CLI and GitHub App setup                                                                      |
| `profiles/staging.json` | Staging bot configuration                                                                              |

## Deployment

`cloudflare.config.ts` configures the staging Worker `emdash-bot-pi` on the EmDash CMS account. `pnpm run deploy:staging` deploys it with secrets from the ignored `.env.staging`. The production Worker (`emdash-bot`) is not configured here; a production profile and Workers Builds are slice 6 operator actions.
