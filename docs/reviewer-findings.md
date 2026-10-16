# Reviewer findings contract

The EmDash reviewer (`infra/flue-review`) already produces a structured result (`verdict`, `summary`, line-anchored `findings` with `needs_fixing` or `suggestion` severity). The bot needs two additions, emitted as a fenced block in the review body alongside the prose:

````markdown
```emdash-review-findings
{
	"version": 1,
	"reviewedCommit": "<head sha the review assessed>",
	"findings": [
		{ "id": "F-3f2a", "severity": "needs_fixing", "path": "packages/core/src/a.ts", "line": 42, "title": "Short title", "body": "What is wrong and why." }
	],
	"dispositions": [
		{ "id": "F-1b07", "status": "resolved", "note": "Fixed by the transaction change." }
	]
}
```
````

- **Stable IDs.** A finding keeps its ID across rounds. The reviewer already reads prior threads; it should reuse the ID of a prior finding it reports again.
- **Dispositions.** For every earlier finding, state `resolved`, `open` or `withdrawn` for the newly reviewed commit. The bot confirms a finding only on the reviewer's disposition, never on the author's claim or a resolved thread.
- **Severity.** `suggestion` findings are recorded but are not actionable; `needs_fixing` findings block readiness.

The adapter is `src/github/review.ts`. Every review, with its inline comments, is delivered to the author as a message; the author decides how to respond. For readiness, the configured reviewer's latest review of the current head must be an approval, or a review whose findings block lists nothing actionable. A review without a block that has a body or inline comments counts as unresolved feedback until the reviewer approves or reviews the new head cleanly. `dispositions` are optional context for the author. The reviewer change belongs in the EmDash repository and is a separate, reviewed change; it is not made from this repository.
