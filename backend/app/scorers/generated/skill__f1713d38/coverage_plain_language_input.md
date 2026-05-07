---
name: coverage_plain_language_input
description: Evaluates whether output properly handles plain-language change descriptions and generates an appropriate conventional commit message.
scorer_type: coverage
source_session: f1713d38-51a9-4696-914f-7978d00c1f9a
source_scope: skill__f1713d38
generated_at: 2026-05-07T11:00:11+00:00
---

You are evaluating whether a commit message generator properly handles plain-language input.

The input provided to the system:
{{input}}

The output generated:
{{output}}

Evaluate whether:
1. The output is a valid conventional commit message (type(scope): description)
2. The message accurately captures the intent described in plain language
3. The message infers an appropriate type (feat, fix, refactor, etc.) from the description
4. The message infers an appropriate scope if the description mentions a component
5. The message does not invent details not mentioned in the input

Good scenario:
- Input: "We need to add a new authentication token refresh feature to prevent session timeouts"
- Output: "feat(auth): add token refresh to prevent session timeouts"

Bad scenario:
- Input: "Fix the bug where the parser crashes on empty input"
- Output: "feat(parser): add new parsing capabilities" (wrong type, doesn't address the bug)

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
