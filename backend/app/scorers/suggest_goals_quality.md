---
name: suggest_goals_quality
turn_type: suggest_goals
description: Evaluates the additional business goals the agent suggests given the user's existing goals.
returns: per-dimension score (novelty, relevance, specificity) + overall verdict
---

# Suggest Goals Quality

You are evaluating a list of suggested business goals that the agent generated to extend the user's existing goal list. The agent's job is to propose goals that meaningfully expand coverage — not duplicates of what the user already has, not tangentially related platitudes, and not so vague the user can't act on them.

## Inputs

The user's existing goals at the time of suggestion:
```
{{input}}
```

The agent's suggested additions:
```
{{output}}
```

If either block above is empty (no existing goals to extend, or no suggestions produced), state explicitly: "scorer payload missing — span input/output not populated", and pick `none_pass`. Do NOT try to evaluate from instructions alone.

---

## What you are evaluating

### Novelty
**PASS if:** each suggestion adds a distinct angle to the existing list. Paraphrase of an existing goal does not count as novel.

**FAIL if:** any suggestion is essentially a restatement of an existing goal — same outcome, different wording. Suggesting "improve user satisfaction" when the user already has "increase customer happiness" is a fail.

### Relevance
**PASS if:** each suggestion plausibly belongs to the same product/feature as the existing goals — same domain, same kind of objective. The user could reasonably say "yes, that's also a goal of mine".

**FAIL if:** suggestions are generic best-practice goals that would apply to any product ("ship faster", "reduce churn") with no traceable connection to what the existing goals describe.

### Specificity
**PASS if:** each suggestion is concrete enough that a product manager could decide whether their feature meets it. Names a measurable outcome, a target user, or a specific scenario.

**FAIL if:** suggestions are vague platitudes — "improve quality", "be more helpful", "drive engagement" — that say nothing the user couldn't have said about anything.

---

## Scoring

Evaluate each of the three dimensions independently and decide PASS or FAIL for each, judging the LIST as a whole. If most suggestions pass on a dimension and one is weak, mark that dimension PASS and note the weak one in your reasoning. If half or more fail on a dimension, that dimension fails.

If the agent produced zero suggestions despite the user having a meaningful goal list, that is a Relevance FAIL (the agent should be able to extend any non-empty starter set).

---

## How to respond

Give 1-2 sentences of reasoning per dimension (Novelty, Relevance, Specificity), explicitly stating PASS or FAIL for each, then choose ONE of these labels based on the total number of passing dimensions:

- `all_pass` — 3 of 3 dimensions pass
- `two_pass` — 2 of 3 dimensions pass
- `one_pass` — 1 of 3 dimensions pass
- `none_pass` — 0 of 3 dimensions pass (or scorer payload was missing)

The harness will record your choice as the score — there is no separate numeric output to write.
