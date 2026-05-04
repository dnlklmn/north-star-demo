---
name: coverage_wellformed_complete_sections
turn_type: skill_seed
description: Evaluates whether the skill correctly extracts all standard sections from a well-formed SKILL.md with complete sections.
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
Determine whether the input is a well-formed SKILL.md with all standard sections:
1. Metadata (name, description)
2. Goals section
3. Users & Stories section
4. Off-target Stories section
5. Task Definition section

If the input contains all these sections, verify that the output JSON contains
corresponding fields:
- name (from metadata)
- description (from metadata)
- goals (array from Goals section)
- positive_stories (array from Users & Stories section)
- off_target_stories (array from Off-target Stories section)
- task_definition (object from Task Definition section)

COVERAGE SUCCESS means:
- Input is well-formed with all standard sections present
- Output JSON contains all corresponding fields
- No sections are missing from the output
- All extracted fields contain data from the input

COVERAGE FAILURE means:
- Input is well-formed but output is missing one or more fields
- Output contains null or empty values for sections that exist in input
- Extraction is incomplete or partial

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
