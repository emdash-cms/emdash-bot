# EmDash bot (Pi)

An EmDash issue and pull-request author service built on Pi Durable, hosted in Cloudflare Durable Objects through `PiHarness`. It preserves completed source changes through interruptions, publishes only saved candidates through trusted code, carries review findings across revisions, and reports readiness from exact-head evidence. Human approval is always required to merge.

[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) is the design and records the implementation status of each slice. [docs/staging.md](docs/staging.md) is the guide for human testing on the staging Worker.

## How it works

- **Intake.** A maintainer applies the `emdash-bot` label to a specific issue or same-repository PR, or assigns a configured machine-user login. Removing it cancels the case. Webhooks are verified, allowlisted, recorded durably by `RepositoryDO` and forwarded to one `CaseDO` per issue or PR.
- **Author.** `CaseDO` hosts Pi through `PiHarness` (`Lifecycle.install(this).use(piHarness)`). Pi's read, write, edit and bash tools run in a Cloudflare Sandbox container through a Pi `ExecutionEnv` adapter. Every source mutation is checkpointed to R2 (a binary patch against the base commit) and committed in the case's SQLite before the tool returns.
- **Candidates and publication.** `submit_candidate` seals the latest acknowledged checkpoint. A Lifecycle job publishes it with GitHub's Git Data API after materializing it in a fresh sandbox and checking that GitHub's tree equals the sealed tree. Each GitHub effect has a durable intent and is reconciled after lost responses. Branches only fast-forward; an advanced branch is integrated once or handed off.
- **Verification and review.** Check runs are classified from exact-head evidence (code, infrastructure, administrative, cancellation, stale, unknown); only code failures start repair. The configured reviewer's findings, including `COMMENTED` reviews, enter a finding ledger with explicit dispositions. Status is computed deterministically and posted as one updateable PR comment.

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
