---
name: alignment_user_story_parsing
turn_type: skill_seed
description: Evaluates whether user stories are decomposed into role, action, and outcome fields following the 'As a [role], I want to [action], so that [outcome]' format.
scorer_type: alignment
source_session: 713a936a-439e-45ad-9302-9ddaf3d15b02
source_scope: skill_seed
generated_at: 2026-05-02T21:02:25+00:00
---

You are evaluating a SKILL.md extraction tool's output.

SOURCE SKILL.MD INPUT:
{{input}}

EXTRACTED JSON OUTPUT:
{{output}}

EVALUATION TASK:
Examine the user stories in the extracted JSON output (in positive_stories array).
Compare the parsed structure against the source SKILL.md input.

The standard user story format is: "As a [role], I want to [action], so that [outcome]"

GOOD ALIGNMENT means:
- Each user story is decomposed into separate 'role', 'action', and 'outcome' fields
- 'role' field correctly extracts the text from 'As a [role]' clause
- 'action' field correctly extracts the text from 'I want to [action]' clause
- 'outcome' field correctly extracts the text from 'so that [outcome]' clause
- Parsing handles the standard format correctly

BAD ALIGNMENT means:
- Stories are returned as unparsed strings without role/action/outcome decomposition
- The role, action, or outcome fields are missing entirely
- Fields are conflated or mixed (e.g., role contains action text)
- Parsing fails silently on malformed stories without indication of error
- Partial parsing where only some stories are decomposed

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
