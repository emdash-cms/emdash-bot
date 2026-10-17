# Self-review answer key

Findings from independent adversarial reviews (2026-10-17) of the bot's original pull requests, which emdashbot did not flag. A self-review or a re-run is scored on whether it finds (step 1) or avoids (step 2) each key finding.

| PR | Issue | Key finding | Severity |
| --- | --- | --- | --- |
| 4226 | 3686 | K1: the route-cache fresh read only runs with an object cache (`request-context.ts` gates `routeCacheFill` on `objectCacheEnabled`); the reporter has none, so the fix reduces to a 30 s TTL | blocker |
| 4226 | 3686 | K2: tests set `routeCacheFill` directly, so they cannot catch K1 | should-fix |
| 4226 | 3686 | K3: hard expiry instead of stale-while-revalidate, unlike the redirect cache: blocking refresh and outage sensitivity | should-fix |
| 4225 | 3669 | K4: widget areas have the identical delete-then-reinsert race, and the Cloudflare templates seed widgets | should-fix |
| 4225 | 3669 | K5: not atomic on the Durable Object SQL backend (no batch or transaction); changeset claim false there | should-fix |
| 4224 | 3577 | K6: rows already stored under a locale code become unreachable after upgrade; "no migration needed" is false | should-fix (borderline blocker) |
| 4224 | 3577 | K7: string-only configs change case behaviour, undocumented | nit |
| 4221 | 3592 | K8: presets or fractional/out-of-range quality make the Cloudflare image endpoint serve full-size originals | should-fix (borderline blocker) |
| 4221 | 3592 | K9: quality is ignored in most render paths and leaks onto `<img>` | should-fix |
| 4201 | 3018 | K10: conflicts with the existing `meta.caption`; per-use override ignored by sites reading `meta.caption` | should-fix |
| 4201 | 3018 | K11: generated site types (`emdash-env.d.ts`) omit `caption` | should-fix |
| 4201 | 3018 | K12: Edit asset overwrites the per-use caption the PR claims to protect | should-fix |
| 4201 | 3018 | K13: seed and export paths skip or mishandle caption | should-fix |
