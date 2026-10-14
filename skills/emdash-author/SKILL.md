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

## Finishing

- Submit a candidate with a conventional-commit title and a summary stating what changed and which checks you ran.
- If the report lacks information needed for a correct fix, or the described behaviour is intended, hand off instead of guessing.
