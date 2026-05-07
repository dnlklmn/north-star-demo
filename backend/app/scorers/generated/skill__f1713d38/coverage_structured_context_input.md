---
name: coverage_structured_context_input
description: Evaluates whether output properly handles structured change context (type, scope, description) and generates a formatted commit message.
scorer_type: coverage
source_session: f1713d38-51a9-4696-914f-7978d00c1f9a
source_scope: skill__f1713d38
generated_at: 2026-05-07T11:00:11+00:00
---

You are evaluating whether a commit message generator properly handles structured input.

The input provided to the system:
{{input}}

The output generated:
{{output}}

Evaluate whether:
1. The output is a valid conventional commit message (type(scope): description)
2. The message uses the type provided in the input (or infers correctly if not provided)
3. The message uses the scope provided in the input (or infers correctly if not provided)
4. The message incorporates the description provided in the input
5. The message fits within 72 characters
6. The message is properly formatted (lowercase, no trailing punctuation)

Good scenario:
- Input: "Type: feat, Scope: auth, Description: add token refresh mechanism"
- Output: "feat(auth): add token refresh mechanism"

Bad scenario:
- Input: "Type: fix, Scope: parser, Description: handle empty input"
- Output: "feat(parser): add new parsing capabilities" (wrong type, ignores description)

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
