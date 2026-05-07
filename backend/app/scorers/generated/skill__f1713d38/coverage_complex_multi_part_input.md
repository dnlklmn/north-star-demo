---
name: coverage_complex_multi_part_input
description: Evaluates whether output properly handles complex multi-part changes and provides guidance on breaking them into separate commits.
scorer_type: coverage
source_session: f1713d38-51a9-4696-914f-7978d00c1f9a
source_scope: skill__f1713d38
generated_at: 2026-05-07T11:00:11+00:00
---

You are evaluating whether a commit message generator properly handles complex multi-part changes.

The input provided to the system:
{{input}}

The output generated:
{{output}}

For complex multi-part changes, the system should:
1. Recognize that the change spans multiple concerns
2. Either:
   a) Generate a single message for the primary concern, OR
   b) Suggest breaking into multiple commits with guidance on how to split them
3. If suggesting multiple commits, provide clear, actionable guidance
4. Each suggested commit should follow conventional commits format

Good scenario:
- Input: "Refactored the auth module AND added token refresh AND updated tests"
- Output: "Consider breaking into:
1. refactor(auth): simplify token handling
2. feat(auth): add token refresh
3. test(auth): update token tests"
  OR
- Output: "feat(auth): add token refresh mechanism" (if focusing on primary change)

Bad scenario:
- Input: "Refactored auth AND added tokens AND updated tests"
- Output: "feat(auth): refactor and add tokens and update tests" (tries to cram everything into one message)

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
