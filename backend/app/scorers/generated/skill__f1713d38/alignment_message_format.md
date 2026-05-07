---
name: alignment_message_format
description: Evaluates whether output follows conventional commits structure with correct type, optional scope, description, no trailing punctuation, and total length ≤72 characters.
scorer_type: alignment
source_session: f1713d38-51a9-4696-914f-7978d00c1f9a
source_scope: skill__f1713d38
generated_at: 2026-05-07T11:00:11+00:00
---

You are evaluating a commit message generator's output.

The output should strictly follow the conventional commits format:
- Structure: type(scope): description
- Valid types: feat, fix, docs, style, refactor, perf, test, chore
- Scope is optional but recommended
- Description must be lowercase and use imperative mood
- No trailing punctuation (no period, exclamation mark, etc.)
- Total length must be ≤72 characters
- No multiple lines

Output to evaluate:
{{output}}

Good examples:
- "feat(auth): add token refresh mechanism"
- "fix: prevent null pointer in parser"
- "refactor(api): simplify endpoint routing for maintainability"

Bad examples:
- "feat(auth): Add token refresh mechanism." (capitalized, trailing period)
- "feat(auth): add token refresh mechanism that improves security and performance" (exceeds 72 chars)
- "feat(auth): add token refresh mechanism
Also refactored the auth module" (multiple lines)

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
