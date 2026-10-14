# EmDash bot

A planned issue and pull-request author service built on Pi Durable and Cloudflare. It will preserve completed changes through interruptions, feed review findings back into the same task, and use CI plus the existing EmDash reviewer to assess each candidate.

Created from [ascorbic/worker-template](https://github.com/ascorbic/worker-template) at `c735a72c77bb9b5f54ff7bfedba5ad86bfc4d978`. The starter Worker and its smoke tests are present. The bot runtime, Cloudflare resources, GitHub integration and evaluation controller remain to be implemented; start with [the implementation plan](IMPLEMENTATION_PLAN.md).

## Local development

Use Node 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The starter responds with `EmDash bot scaffold` at `/` and a sample JSON response at `/api/hello`.

```sh
pnpm check    # formatting, lint and type checking through Vite+
pnpm test     # build, then run the Worker smoke tests in Miniflare
pnpm build   # production Worker bundle
pnpm types   # regenerate Env and runtime types after binding changes
```

`cloudflare.config.ts` defines the Worker and its bindings through `cf/config`. `compatibility.ts` shares runtime settings with the test harness; `vite.config.ts` configures Vite+, Vitest, oxlint and oxfmt. Keep the template's toolchain and Miniflare pins together.

## Deployment

`pnpm deploy` builds and deploys through the `cf` CLI. Account selection, staging resources, credentials and Workers Builds setup are deferred to the implementation plan. No Cloudflare deployment has been configured or performed.
