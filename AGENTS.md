This file provides guidance to agentic coding tools when working with code in this repository.

## Project scope

This is the EmDash bot repository, created from `ascorbic/worker-template`. Read [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) before adding runtime code. The current Worker is a scaffold; bot execution, resources, GitHub integration and evals are still proposed.

- Keep Pi Durable as the agent runtime, hosted through `PiHarness` from `agents/harness/pi`; do not write a bespoke lifecycle adapter or introduce a second model/task scheduler.
- Preserve acknowledged edits in immutable source artifacts independently of containers, and publish only a saved candidate through trusted code.
- Keep the existing EmDash review service. Findings and exact-head verification determine readiness; publication alone does not.
- Human approval remains required for merges. Keep deployment and production intake as explicit operator actions.
- Use `cf-portal` for internal Cloudflare documentation and `cloudflare-api`, `cf` or Wrangler for Cloudflare operations. Do not open the Cloudflare dashboard.
- Follow the target repository's current instructions and contribution policy when generating its changes. This repository's checks validate the bot, not an EmDash candidate.

## Deployment setup

No Cloudflare account, resources or deployment connection has been configured. Resolve staging setup in slice 1. Production deploys should use Workers Builds with the build command empty and deploy command `pnpm run deploy`. The optional template Claude assistant workflow has been removed; no Claude OAuth secret is required by this scaffold.

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
