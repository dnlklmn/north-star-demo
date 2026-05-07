---
name: alignment_conciseness
description: Evaluates whether output captures what changed and why in a single terse line without filler, redundancy, or verbose phrasing.
scorer_type: alignment
source_session: f1713d38-51a9-4696-914f-7978d00c1f9a
source_scope: skill__f1713d38
generated_at: 2026-05-07T11:00:11+00:00
---

You are evaluating a commit message for conciseness.

The message should:
- Capture both WHAT changed and WHY it matters in a single line
- Avoid filler words, redundant phrasing, or over-explanation
- Use imperative mood ("add" not "added")
- Omit unnecessary articles ("the", "a")
- Be terse but not cryptic

Output to evaluate:
{{output}}

Good examples (concise, captures what and why):
- "fix(auth): reject expired tokens to prevent session hijacking"
- "refactor(parser): simplify token matching for maintainability"
- "perf(db): cache query results to reduce latency"

Bad examples (verbose, redundant, or unclear):
- "feat(auth): we have added a new feature that allows users to refresh their authentication tokens" (verbose, uses "we have added")
- "fix: fixed the bug" (redundant, doesn't explain what or why)
- "refactor(parser): refactored the parser module to make it better" (vague, doesn't explain the benefit)

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
