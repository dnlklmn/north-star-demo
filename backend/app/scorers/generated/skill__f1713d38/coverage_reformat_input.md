---
name: coverage_reformat_input
description: Evaluates whether output properly reformats a proposed commit message to conventional commits standard.
scorer_type: coverage
source_session: f1713d38-51a9-4696-914f-7978d00c1f9a
source_scope: skill__f1713d38
generated_at: 2026-05-07T11:00:11+00:00
---

You are evaluating whether a commit message generator properly reformats a non-standard message.

The input provided to the system:
{{input}}

The output generated:
{{output}}

Evaluate whether:
1. The output is a valid conventional commit message (type(scope): description)
2. The message preserves the core intent/content of the input message
3. The message corrects format issues (capitalization, punctuation, structure)
4. The message fits within 72 characters
5. The message uses imperative mood

Good scenario:
- Input: "Added new authentication token refresh feature."
- Output: "feat(auth): add token refresh mechanism"

Bad scenario:
- Input: "Fixed the parser bug."
- Output: "feat(parser): add new parsing capabilities" (changes intent, wrong type)

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
