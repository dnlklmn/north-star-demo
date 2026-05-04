---
name: coverage_story_format_parsing
turn_type: skill_seed
description: Evaluates whether the skill correctly parses user stories in 'As a [role], I want to [action], so that [outcome]' format into structured fields.
scorer_type: coverage
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
Examine the user stories in the input SKILL.md. Determine whether they follow
the standard format: "As a [role], I want to [action], so that [outcome]"

If stories ARE in this standard format, verify that the output JSON:
- Parses each story into separate 'role', 'action', and 'outcome' fields
- Correctly extracts the role from the 'As a [role]' clause
- Correctly extracts the action from the 'I want to [action]' clause
- Correctly extracts the outcome from the 'so that [outcome]' clause
- Each story is represented as a structured object with these three fields

COVERAGE SUCCESS means:
- Input contains stories in standard format
- Output correctly parses all stories into role/action/outcome fields
- Parsing is accurate and complete for all stories
- No stories are left unparsed

COVERAGE FAILURE means:
- Input contains stories in standard format but output doesn't parse them
- Stories remain as unparsed strings
- Parsing is incomplete or only partial
- Some stories are parsed but others are not

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
