This file provides guidance to agentic coding tools when working with code in this repository.

## ⚠️ Template Setup Required

**This is currently a template repository.** If you see this message, check if this is a new repo based on the template, by seeing if the git remote is ascorbic/worker-template. If not, you need to set up a new project by updating the following:

1. **Worker name**: Update `worker.name` in `cloudflare.config.ts` and `name` in `package.json` to your new Worker name
2. **README**: Update README.md with your project information
3. **Test files**: Update the greeting string in `src/index.ts` and the matching assertion in `test/index.test.ts`, and rename the test file if appropriate
4. **Workers Builds**: Deploys run on Cloudflare's [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), not GitHub Actions. Tell the user to connect the repository in the Cloudflare dashboard (Worker → **Settings** → **Build**), leaving the build command empty and setting the deploy command to `pnpm run deploy` (`vp build`, then `cf deploy --prebuilt`).

5. **GitHub Secrets**: For `CLAUDE_CODE_OAUTH_TOKEN` (used by claude.yml): Tell the user to open Claude Code and run the `/install-github-app` command, which will guide them through setting up the GitHub app and automatically add the secret to their repository. Note: The user must be a repository admin to install the GitHub app and add secrets.

6. **Repository Settings and Branch Protection**: Configure repository settings and branch protection rules using the GitHub CLI. Get the current repository name first:

   ```bash
   # Get repository name (format: owner/repo)
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

   # Configure repository settings
   gh api repos/$REPO --method PATCH \
     -f allow_squash_merge=true \
     -f allow_merge_commit=false \
     -f allow_rebase_merge=false \
     -f delete_branch_on_merge=true \
     -f allow_auto_merge=true \
     -f allow_update_branch=true \
     -f squash_merge_commit_message=COMMIT_MESSAGES \
     -f squash_merge_commit_title=COMMIT_OR_PR_TITLE \
     -f has_wiki=false

   # Create branch protection ruleset for main branch
   gh api repos/$REPO/rulesets --method POST --input - <<'EOF'
   {
     "name": "main",
     "target": "branch",
     "enforcement": "active",
     "conditions": {
       "ref_name": {
         "include": ["~DEFAULT_BRANCH"],
         "exclude": []
       }
     },
     "rules": [
       {"type": "deletion"},
       {"type": "non_fast_forward"},
       {"type": "required_linear_history"},
       {
         "type": "pull_request",
         "parameters": {
           "required_approving_review_count": 0,
           "dismiss_stale_reviews_on_push": false,
           "require_code_owner_review": false,
           "require_last_push_approval": false,
           "required_review_thread_resolution": false,
           "allowed_merge_methods": ["merge", "squash", "rebase"]
         }
       },
       {
         "type": "required_status_checks",
         "parameters": {
           "strict_required_status_checks_policy": true,
           "do_not_enforce_on_create": true,
           "required_status_checks": [
             {"context": "test"},
             {"context": "Validate PR title"}
           ]
         }
       }
     ],
     "bypass_actors": [
       {"actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always"}
     ]
   }
   EOF
   ```

After setup, remove this section from AGENTS.md.

## Repository Structure

A standalone Cloudflare Worker built with Vite+ and the Cloudflare Vite plugin.

- `src/index.ts` — the Worker entrypoint
- `test/` — Vitest tests in Node. Integration tests run the built Worker in Miniflare (`test/harness.ts`); `test/global-setup.ts` builds it first
- `cloudflare.config.ts` — Worker configuration, via `defineConfig` from `cf/config` (there is no wrangler.jsonc, and no Wrangler dependency at all)
- `compatibility.ts` — compatibility date/flags, shared between the Worker config and the test runtime
- `vite.config.ts` — unified Vite+ config: Vite plugins, Vitest, oxlint, and oxfmt
- `.cloudflare/types/` — generated `Env` and runtime types; not committed. `cf workers types` regenerates them (runs on `postinstall`, or `pnpm types`)

## Commands

- `pnpm dev` — start the dev server (`vp dev`). `cf dev` and `cf build` expect a `vite` binary, which Vite+ doesn't provide, so use `vp`
- `pnpm test` — build the Worker, then run tests against it in Miniflare
- `pnpm check` — format check, lint, and type check in one pass (`vp check`)
- `pnpm fix` — apply formatting and safe lint fixes
- `pnpm build` — production build
- `pnpm types` — regenerate the types in `.cloudflare/types/` (`cf workers types`)
- `pnpm deploy` — `vp build` then `cf deploy --prebuilt` (requires `cf auth login` or `CLOUDFLARE_API_TOKEN`). Production deploys normally happen via Workers Builds on push to main, not from CI or local machines

## Configuration Architecture

- **`cloudflare.config.ts` is the source of truth for the Worker**: name, entrypoint, compatibility, bindings, observability. It uses `defineConfig({ worker: { ... } })` from `cf/config`, which both the `cf` CLI and the Vite plugin read.
- The entrypoint uses the `with { type: "cf-worker" }` import attribute. This is what makes `Env` and `exports` inference work — keep that form when changing the entrypoint.
- **Bindings**: declare them in `cloudflare.config.ts` (e.g. `env: { MY_KV: bindings.kv() }` with `bindings` from the same import). The `Env` type is inferred from them — run `pnpm types` after config changes. If tests need the bindings, declare them for Miniflare in `test/harness.ts` too, and keep the two in step.
- **`compatibility.ts`** exists so the test runtime (`test/harness.ts`) always matches the deployed runtime. Extra exports are not allowed in `cloudflare.config.ts` (its exports are schema-validated), which is why this is a separate file.
- **Version pins that must move together**: the `vite@*` and `vitest@*` overrides in `pnpm-workspace.yaml` pin Vite to `@voidzero-dev/vite-plus-core` at the installed `vite-plus` version, and Vitest to the version `vp toolchain vitest` reports. Update them whenever `vite-plus` changes. There are no direct `vite` or `vitest` dependencies: import test APIs from `vite-plus/test`.
- **`miniflare`** is pinned to the version `cf` and `@cloudflare/vite-plugin` use (check with `pnpm why miniflare`), so tests run on the same runtime as dev.

## Testing

- Unit tests run in Node. Integration tests use `startWorker()` from `test/harness.ts`, which loads the built Worker (`.cloudflare/output/v0/workers/default/bundle/index.js`) into Miniflare; use `mf.dispatchFetch()` for HTTP. Create the instance in `beforeAll` and dispose of it in `afterAll`.
- `test/global-setup.ts` runs `vp build` once per test run, with `VITEST` unset so `vite.config.ts` loads the Cloudflare plugin.
- `test/tsconfig.json` extends the root config with Node types; the root `tsconfig.json` excludes `test`.

## Development Workflow

- Uses **pnpm**, wrapped by **Vite+** (`vp`). Format and lint are oxfmt/oxlint via `vp check` — there is no prettier or eslint. Type checking runs inside `vp check` (tsgolint with `typeAware`/`typeCheck` enabled).
- Formatting uses tabs (configured in `vite.config.ts` under `fmt`).
- CI (test.yml) runs `vp check`, `vp test`, and `vp build` via the `voidzero-dev/setup-vp` action.
