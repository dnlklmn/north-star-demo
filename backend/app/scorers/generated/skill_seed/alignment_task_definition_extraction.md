---
name: alignment_task_definition_extraction
turn_type: skill_seed
description: Evaluates whether task section is extracted as structured JSON object with input/output descriptions, not raw markdown.
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
Examine the 'task_definition' field in the extracted JSON output.
Compare it against the Task Definition section in the source SKILL.md input.

The task definition should contain:
- input_description: Description of what the task accepts as input
- output_description: Description of what the task produces as output
- sample_input (optional): Example input
- sample_output (optional): Example output

GOOD ALIGNMENT means:
- Task section is extracted and returned as a structured JSON object
- All present task components are converted to appropriate JSON fields
- Input and output descriptions are clearly separated into distinct fields
- Sample input/output (if present) are included as separate fields
- No raw markdown formatting remains in the structured fields

BAD ALIGNMENT means:
- Task section is omitted entirely from output
- Task section is truncated or incomplete
- Task section is returned as raw markdown text instead of structured JSON
- Task components are not separated into distinct fields
- Markdown formatting (##, -, etc.) remains in the output

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
