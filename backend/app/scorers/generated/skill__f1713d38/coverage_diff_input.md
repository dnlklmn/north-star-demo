---
name: coverage_diff_input
description: Evaluates whether output properly handles a git diff as input and generates an appropriate conventional commit message.
scorer_type: coverage
source_session: f1713d38-51a9-4696-914f-7978d00c1f9a
source_scope: skill__f1713d38
generated_at: 2026-05-07T11:00:11+00:00
---

You are evaluating whether a commit message generator properly handles a git diff as input.

The input provided to the system:
{{input}}

The output generated:
{{output}}

Evaluate whether:
1. The output is a valid conventional commit message (type(scope): description)
2. The message accurately reflects the changes shown in the diff
3. The message captures the primary purpose/type of change (feat, fix, refactor, etc.)
4. The message is appropriate for the scope of changes in the diff
5. The message does not invent changes not present in the diff

Good scenario:
- Input: A diff showing changes to auth.js that add a new token refresh function
- Output: "feat(auth): add token refresh mechanism"

Bad scenario:
- Input: A diff showing only formatting changes to a parser
- Output: "feat(parser): add new parsing algorithm" (invents changes not in diff)

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
