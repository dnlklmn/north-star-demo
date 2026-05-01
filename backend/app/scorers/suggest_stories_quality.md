---
name: suggest_stories_quality
turn_type: suggest_stories
description: Evaluates the user stories the agent suggests given the existing goals + stories.
returns: per-dimension score (novelty, goal-alignment, concreteness) + overall verdict
---

# Suggest Stories Quality

You are evaluating a list of suggested user stories the agent generated. The agent looked at the user's goals and any existing stories, and proposed additional stories (each with a `who`, `what`, and `why`) to extend coverage. Your job is to judge whether those suggestions are useful additions or filler.

A user story has the shape: "As a [who], I want to [what], so that [why]."

## Inputs

The goals + existing stories the agent was working from:
```
{{input}}
```

The agent's suggested additional stories (JSON array):
```json
{{output}}
```

If either block above is empty (no goals at all, or no suggestions produced), state explicitly: "scorer payload missing — span input/output not populated", and pick `none_pass`. Do NOT try to evaluate from instructions alone.

---

## What you are evaluating

### Novelty
**PASS if:** each suggested story covers a distinct scenario from the existing stories. Different `who`, different `what`, or a meaningfully different `why`.

**FAIL if:** any suggestion essentially duplicates an existing story — same role doing the same thing for the same reason, just reworded. Multiple suggestions covering the same scenario also count against Novelty.

### Goal-alignment
**PASS if:** each suggested story traces back to at least one of the stated goals. A reader could point to the goal the story serves.

**FAIL if:** suggestions are off-topic — describing scenarios the goals don't actually cover, or generic "user does X" stories that fit any product. If the goals are about internal tooling and the agent suggests external-customer stories with no goal coverage for that, it's a fail.

### Concreteness
**PASS if:** each story names a specific role (not "the user"), a specific action (not "uses the feature"), and a specific reason that ties to a real outcome. You could generate a concrete input/output example from the story without making assumptions.

**FAIL if:** stories are vague — "As a user, I want to use the feature, so that it helps me" — or any of the three slots is missing or so generic it adds no information.

---

## Scoring

Evaluate each of the three dimensions independently and decide PASS or FAIL for each, judging the LIST of suggestions as a whole. A single weak story among many strong ones is a note in the reasoning, not an automatic dimension fail.

If the agent produced zero suggestions despite a non-empty goal list, that is a Goal-alignment FAIL — the agent should be able to extend any plausible goal set.

---

## How to respond

Give 1-2 sentences of reasoning per dimension (Novelty, Goal-alignment, Concreteness), explicitly stating PASS or FAIL for each, then choose ONE of these labels based on the total number of passing dimensions:

- `all_pass` — 3 of 3 dimensions pass
- `two_pass` — 2 of 3 dimensions pass
- `one_pass` — 1 of 3 dimensions pass
- `none_pass` — 0 of 3 dimensions pass (or scorer payload was missing)

The harness will record your choice as the score — there is no separate numeric output to write.
