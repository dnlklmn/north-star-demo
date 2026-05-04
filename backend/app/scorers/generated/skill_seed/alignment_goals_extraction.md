---
name: alignment_goals_extraction
turn_type: skill_seed
description: Evaluates whether the inferred business goals are derivable from the SKILL.md and read as business outcomes — not technical means or fabricated scope.
scorer_type: alignment
source_session: 713a936a-439e-45ad-9302-9ddaf3d15b02
source_scope: skill_seed
generated_at: 2026-05-02T21:02:25+00:00
---

You are evaluating the `goals` array a SKILL.md seeding agent produced.

The agent's job (per its system prompt) is to **infer** 2–4 business goals from a SKILL.md — even when the source has no explicit "Goals" section. So the right question is not "did it copy goals verbatim from the source?" — most SKILL.md files have nothing to copy. The right question is: **are the inferred goals grounded in what the SKILL.md actually says it does, expressed as business outcomes for end users?**

SOURCE SKILL.MD INPUT:
{{input}}

EXTRACTED JSON OUTPUT:
{{output}}

If either block above is empty, blank, or contains only schema/instruction text (no actual SKILL content or seeded bundle), state explicitly: "scorer payload missing — span input/output not populated", and pick `fail`. Do NOT try to evaluate from instructions alone.

## What you are evaluating

### 1. Grounded in the SKILL.md
**PASS:** every goal traces back to capability, audience, or behaviour the SKILL.md actually describes — its purpose statement, its "when to use" section, its keywords, its examples. Inference is fine; invention is not.

**FAIL:** a goal claims a capability the skill doesn't have, names an audience the skill doesn't serve, or paraphrases something the skill explicitly disclaims.

### 2. Business-level, not technical
**PASS:** goals describe outcomes for end users or the business — what the skill *achieves for someone*. Examples of good shape: "Help engineers ship status updates faster", "Reduce inconsistency in customer-facing copy", "Make incident reports easier for non-writers to draft".

**FAIL:** goals describe technical means rather than outcomes — "load the right template file", "parse markdown", "call the LLM with the right prompt" — or are generic platitudes ("be helpful", "produce good output") that say nothing skill-specific.

### 3. Count and granularity
**PASS:** 2–4 goals, each distinct from the others. No near-duplicates that say the same thing in different words.

**FAIL:** fewer than 2, more than 4, or two/more goals collapse to the same point on read.

## Scoring

Evaluate each of the three dimensions independently. Be especially conservative on dimension 1 — invented scope corrupts every downstream eval.

## How to respond

Give 1-2 sentences of reasoning per dimension, then end your response with ONE of these labels on its own line:

- `pass` — all three dimensions pass
- `partial` — at least one dimension fails but the goals are recognisably grounded and useful
- `fail` — multiple dimensions fail, goals are clearly fabricated, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
