---
name: evaluate_goals_quality
turn_type: evaluate_goals
description: Evaluates the per-goal feedback the agent emits when judging the user's typed goals.
returns: per-dimension score (accuracy, restraint, actionability) + overall verdict
---

# Evaluate Goals Quality

You are evaluating the feedback the agent generated about the user's business goals. For each goal the user typed, the agent decides whether to flag an issue and (optionally) propose a rewritten version. Your job is to judge whether that feedback is correct, restrained, and useful.

You are not judging whether the user's goals are good business goals. You are judging whether the agent's feedback about them is right.

## Inputs

The goals the user submitted for evaluation:
```
{{input}}
```

The agent's feedback (a JSON list, one entry per goal — each entry has `goal`, `issue`, and `suggestion` fields; `issue` and `suggestion` are null when the agent thinks the goal is fine):
```json
{{output}}
```

If either block above is empty, blank, or contains only schema/instruction text, state explicitly: "scorer payload missing — span input/output not populated", and pick `none_pass`. Do NOT try to evaluate from instructions alone.

---

## What you are evaluating

### Accuracy
**PASS if:** every flagged issue is a real issue with the corresponding goal — vagueness, missing measurability, ambiguous target user, conflict with another goal. The flagged problem is something a careful PM would also notice.

**FAIL if:** the agent flagged a goal as having an issue when the goal is genuinely fine, OR missed a clear issue in a goal that obviously needed flagging. A vague platitude that the agent waved through is an Accuracy FAIL.

### Restraint
**PASS if:** the agent left obviously-good goals alone (issue: null). It did not invent issues to look diligent. It did not over-rewrite goals that were already concrete.

**FAIL if:** the agent flagged most or all goals regardless of quality, treating "issue" as a default rather than an exception. Flagging every goal is the same as flagging none — it stops being a useful signal.

### Actionability
**PASS if:** when the agent did propose a `suggestion`, the rewrite actually addresses the flagged issue and is concrete enough to use. The user could replace their goal with the suggestion and be in a better place.

**FAIL if:** suggestions are vague rewrites that don't fix the flagged issue, or suggestions are themselves platitudes ("make it more specific" without saying how), or the suggestion changes the goal's intent rather than tightening it.

---

## Scoring

Evaluate each of the three dimensions independently and decide PASS or FAIL for each, judging the feedback list as a whole.

If the goal list has very few items (1-2), give the benefit of the doubt on Restraint unless the agent flagged everything.

---

## How to respond

Give 1-2 sentences of reasoning per dimension (Accuracy, Restraint, Actionability), explicitly stating PASS or FAIL for each, then choose ONE of these labels based on the total number of passing dimensions:

- `all_pass` — 3 of 3 dimensions pass
- `two_pass` — 2 of 3 dimensions pass
- `one_pass` — 1 of 3 dimensions pass
- `none_pass` — 0 of 3 dimensions pass (or scorer payload was missing)

The harness will record your choice as the score — there is no separate numeric output to write.
