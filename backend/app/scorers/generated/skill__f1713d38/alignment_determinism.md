---
name: alignment_determinism
description: Evaluates whether output is deterministic (same input produces same output) with no alternatives, options, or variations offered.
scorer_type: alignment
source_session: f1713d38-51a9-4696-914f-7978d00c1f9a
source_scope: skill__f1713d38
generated_at: 2026-05-07T11:00:11+00:00
---

You are evaluating whether a commit message output is deterministic.

The output should:
- Be a single, definitive commit message
- NOT include multiple suggestions or alternatives
- NOT use words like "or", "alternatively", "you could also", "option 1", "option 2"
- NOT ask the user to choose between options
- NOT hedge or suggest variations

Output to evaluate:
{{output}}

Good examples (deterministic, single message):
- "feat(auth): add token refresh mechanism"
- "fix(parser): handle empty input gracefully"

Bad examples (non-deterministic, offers alternatives):
- "feat(auth): add token refresh mechanism or implement session renewal"
- "You could write: 'feat(auth): add tokens' or 'feat(auth): implement refresh'"
- "fix(parser): handle empty input (or you could validate on entry)"
- "Option 1: feat(auth): add tokens
Option 2: feat(auth): refresh session"

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
