---
name: alignment_positive_vs_offtarget_separation
turn_type: skill_seed
description: Evaluates whether off-target stories are correctly separated from positive stories into distinct arrays.
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
Examine the story arrays in the extracted JSON output. The source SKILL.md should have
two distinct sections: "Users & Stories" (positive stories) and "Off-target Stories".

GOOD ALIGNMENT means:
- Stories from the 'Users & Stories' section are placed in the 'positive_stories' array
- Stories from the 'Off-target Stories' section are placed in the 'off_target_stories' array
- The two arrays are kept completely separate with no mixing
- The boundary between sections is respected and enforced

BAD ALIGNMENT means:
- Off-target and positive stories are mixed in a single array
- Stories are placed in the wrong array (positive stories in off_target_stories or vice versa)
- The boundary between sections is ignored or unclear
- Stories from off-target section appear in positive_stories array

## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
