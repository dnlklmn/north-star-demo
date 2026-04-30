---
name: goal_extraction_quality
turn_type: discovery
phase: goals
description: Evaluates the goals the agent extracts from the user during the goals phase of discovery.
returns: per-dimension score (completeness, specificity, faithfulness) + overall verdict
---

# Goal Extraction Quality

You are evaluating how well a discovery agent extracted business goals from a user conversation. The agent's job is to capture every concrete goal the user mentioned, leave nothing out, and not invent things.

You are not evaluating whether the goals themselves are good business goals. You are evaluating whether the *extraction* faithfully reflects what the user said.

The conversation is in `{{input}}`. The agent's response (which contains an `extraction` block with a `goals` array) is in `{{output}}`.

---

## What you are evaluating

### Completeness
**PASS if:** every goal the user explicitly stated or clearly implied was captured in the goals array.

**FAIL if:** the user mentioned a concrete goal (a thing they want this AI feature to achieve) and the agent did not include it.

Be generous on phrasing — the agent paraphrasing "make customers happy" as "improve customer satisfaction" is fine. What matters is whether the *idea* survived.

### Specificity
**PASS if:** each extracted goal is concrete enough that someone reading it cold could tell what the AI feature is meant to achieve. "Reduce return processing time by 30 seconds per ticket" passes. "Improve efficiency" does not.

**FAIL if:** goals are vague platitudes — "improve user experience", "be helpful", "drive engagement" — that say nothing the user couldn't have said about literally any product.

If the user themselves was vague, the agent should either ask a clarifying question or extract the goal as-stated and flag it. If the agent silently "fixed" a vague goal by inventing specificity, that's a faithfulness problem, not a specificity problem.

### Faithfulness
**PASS if:** every extracted goal corresponds to something the user actually said or clearly implied.

**FAIL if:** the agent invented goals not present in the conversation. This includes "reasonable defaults" the agent assumed — they may be reasonable but they are not faithful to *this* user.

Hallucinated goals are a critical failure: they pollute downstream charter generation with priorities the user never set.

---

## Scoring

Evaluate each dimension and return an overall verdict.

- **Overall GOOD:** all three dimensions pass
- **Overall BAD:** any dimension fails

Be especially conservative on faithfulness — false positives (calling a hallucination faithful) silently corrupt the rest of the eval pipeline.

---

## Output format

Return your reasoning (1-2 sentences per dimension), then on a NEW FINAL LINE write:
SCORE: <number between 0.0 and 1.0>

Where the score is the fraction of dimensions that pass — 3/3 = 1.0, 2/3 ≈ 0.67, 1/3 ≈ 0.33, 0/3 = 0.0. The SCORE: line must be the last line of your response.
