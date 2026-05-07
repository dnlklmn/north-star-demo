---
name: alignment_scope_boundary
description: Evaluates whether output is a single commit message only, with no rationale, educational commentary, code explanation, or documentation.
scorer_type: alignment
source_session: f1713d38-51a9-4696-914f-7978d00c1f9a
source_scope: skill__f1713d38
generated_at: 2026-05-07T11:00:11+00:00
---

You are evaluating whether a commit message output respects scope boundaries.

The output should:
- Be ONLY a single commit message
- NOT include explanations of why the change was made
- NOT include what the code does or how it works
- NOT include feedback on the user's proposed message
- NOT include educational commentary or rationale
- NOT include documentation or examples
- NOT include commit body or multi-line content

Output to evaluate:
{{output}}

Good examples (in-scope, message only):
- "feat(auth): add token refresh mechanism"
- "fix(parser): handle empty input gracefully"

Bad examples (out-of-scope, includes extra content):
- "feat(auth): add token refresh mechanism

This change improves security by allowing tokens to be refreshed without re-authentication."
- "fix(parser): handle empty input gracefully

Why: The parser was crashing when given empty strings. This fix validates input before processing."
- "Your message 'add auth tokens' should be formatted as: feat(auth): add token refresh mechanism. This follows conventional commits."
- "feat(auth): add token refresh mechanism

Explanation: This allows users to maintain sessions longer without logging in again."

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
