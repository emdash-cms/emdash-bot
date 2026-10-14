# worker-template

Template for standalone Cloudflare Workers.

## Stack

- [Vite+](https://viteplus.dev/) (`vp`) — dev server, build, test, lint, format, and type checking in one toolchain
- [`cf`](https://www.npmjs.com/package/cf) — the Cloudflare CLI (technical preview), for deploys and everything Cloudflare
- [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/) 2.0, with `cloudflare.config.ts` from `cf/config`
- Vitest in Node, with integration tests running the built Worker in [Miniflare](https://www.npmjs.com/package/miniflare). No Wrangler
- TypeScript, pnpm

## Commands

```sh
pnpm dev      # dev server (with the Cloudflare local explorer at /cdn-cgi/local/explorer)
pnpm test     # build, then test the Worker in Miniflare
pnpm check    # format, lint, and type check
pnpm fix      # same, but auto-fix
pnpm build    # production build
pnpm types    # regenerate Env and runtime types
pnpm deploy   # build and deploy via cf
```

## Configuration

- [cloudflare.config.ts](cloudflare.config.ts) — the Worker itself: name, entrypoint, compatibility, bindings. `Env` types are inferred from the bindings you declare here and generated into `.cloudflare/types/` by `cf workers types` (run on install, or with `pnpm types`).
- [compatibility.ts](compatibility.ts) — compatibility date and flags, shared with the test runtime.
- [vite.config.ts](vite.config.ts) — everything else: Vite, Vitest, oxlint, and oxfmt in one file.

## Template setup

This is a template repository. After creating a repo from it, follow the setup steps in [AGENTS.md](AGENTS.md) — or just ask Claude to do it.
