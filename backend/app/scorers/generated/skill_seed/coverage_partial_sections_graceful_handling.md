---
name: coverage_partial_sections_graceful_handling
turn_type: skill_seed
description: Evaluates whether the skill gracefully handles SKILL.md with partial sections by returning valid JSON with empty arrays for missing sections.
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
Determine whether the input is a SKILL.md with PARTIAL sections (some sections
present, others missing or empty). For example:
- Goals section present but Off-target Stories section absent
- Users & Stories present but Task Definition missing
- Only metadata and description present

For sections that ARE present in input, verify they are extracted to output.
For sections that are MISSING or EMPTY in input, verify the output handles them
gracefully by:
- Including the corresponding field in output JSON
- Setting the field to an empty array [] for list fields
- Setting the field to null or empty object {} for object fields
- NOT omitting the field entirely
- Returning valid, parseable JSON

COVERAGE SUCCESS means:
- Output is valid JSON even when input has missing sections
- Present sections are extracted correctly
- Missing sections result in empty arrays/objects, not omitted fields
- No parsing errors or malformed JSON

COVERAGE FAILURE means:
- Output is invalid JSON
- Missing sections cause the entire extraction to fail
- Fields are omitted instead of set to empty values
- Output is incomplete or contains errors

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
