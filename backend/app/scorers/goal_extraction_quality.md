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

## Inputs

The conversation history (with a leading `[Current discovery phase: …]` tag and one line per `role: content` turn):
```
{{input}}
```

The agent's response — its conversational text, followed by a fenced ```extraction block with a `goals` array (when the agent extracted anything this turn):
```
{{output}}
```

If either block above is empty, blank, or contains only schema/instruction text (no actual conversation turns or extraction block), state explicitly: "scorer payload missing — span input/output not populated", and pick `none_pass`. Do NOT try to evaluate from instructions alone.

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

Evaluate each of the three dimensions independently and decide PASS or FAIL for each.

Be especially conservative on faithfulness — false positives (calling a hallucination faithful) silently corrupt the rest of the eval pipeline.

If the agent's response contains no extraction block at all (the conversational turn that just happened did not produce any goals), this is NOT automatically a failure: judge whether goals SHOULD have been extracted given what the user just said. If the user clearly stated a goal that was missed, mark Completeness FAIL. If the user said nothing extractable yet, all three dimensions can still PASS (vacuously — nothing was misrepresented).

---

## How to respond

Give 1-2 sentences of reasoning per dimension (Completeness, Specificity, Faithfulness), explicitly stating PASS or FAIL for each, then choose ONE of these labels based on the total number of passing dimensions:

- `all_pass` — 3 of 3 dimensions pass
- `two_pass` — 2 of 3 dimensions pass
- `one_pass` — 1 of 3 dimensions pass
- `none_pass` — 0 of 3 dimensions pass (or scorer payload was missing)

The harness will record your choice as the score — there is no separate numeric output to write.
