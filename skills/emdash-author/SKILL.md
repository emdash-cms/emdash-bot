# EmDash author method

Use this when implementing an EmDash issue or repairing an EmDash pull request.

## Before changing code

- Read `AGENTS.md` and `CONTRIBUTING.md` in the checkout; they are the target repository's current rules.
- Find the code path the issue describes and read its tests. Reproduce the failure with a focused test when you can.
- Note adjacent failure paths: error handling around the change, other dialects (SQLite and PostgreSQL), plugin concurrency, and partially migrated databases.

## While changing code

- Keep the change scoped to the issue. Do not refactor unrelated code.
- User-visible admin strings must be wrapped for translation (Lingui). Do not edit `messages.po` catalogs; a workflow extracts them.
- Public API changes need documentation and exports kept in sync.
- A change to a published package needs a changeset describing the user-facing effect.

## Verifying

- Prefer the narrowest test command that exercises the change, for example `pnpm --filter <package> exec vitest run <file>`.
- Build declaration output for packages your test imports before trusting a test result; stale `dist` output is not evidence.
- Broad checks (full test suite, lint, typecheck, format) run in CI on the published commit. Run focused checks here.
- `pnpm lint:json` won't run in the sandbox; use `pnpm lint:quick`.
- Run admin tests with the package's own config; Chromium is available.

## Screenshots

CONTRIBUTING asks for before-and-after screenshots of every screen a UI change affects. Take them through the e2e harness, which starts, sets up and seeds a fixture server and stops it again, all within one command:

1. Build first: `ulimit -n 65536; NODE_OPTIONS=--max-old-space-size=8192 pnpm build` (or only the changed packages). The fixture serves built `dist` output, so rebuild after every source change you want to show.
2. Write a temporary spec, such as `e2e/tests/zz-screenshots.spec.ts`, that imports `test` and `expect` from `../fixtures`. Use the `admin` fixture: `admin.devBypassAuth()`, `admin.dismissOnboardingModal()`, the `admin.goTo…` helpers and `admin.waitForLoading()`. Then call `page.screenshot({ path: "/tmp/<name>.png" })`, or `locator.screenshot()` to crop to the changed area. Keep the viewport and content identical between the two runs.
3. Run it with `pnpm exec playwright test e2e/tests/zz-screenshots.spec.ts --reporter=line`.
4. Take the before shots before you change the code. If you have already changed it, `git stash -u`, rebuild, run the spec, then `git stash pop` and rebuild.
5. Look at each image before you attach it: a blank page, an onboarding modal or an error overlay is not a screenshot of the change. Delete the temporary spec, then publish the images with `attach_screenshot`.

Shoot the real admin through the fixture, not an unstyled component harness.

## Finishing

- Submit a candidate with a conventional-commit title and a summary stating what changed and which checks you ran.
- If the report lacks information only the reporter has, ask them on the issue. If the described behaviour is intended, reply explaining why rather than changing code.
