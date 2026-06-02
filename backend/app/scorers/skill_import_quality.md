---
name: skill_import_quality
turn_type: skill_import
description: Evaluates the goals/users/stories/task bundle the agent seeds from a pasted SKILL.md.
returns: per-dimension score (faithfulness, completeness, specificity) + overall verdict
---

# Skill Seed Quality

You are evaluating how well the agent bootstrapped a North Star session from a pasted SKILL.md. The agent's job is to read the skill body and emit a structured bundle (goals, users, positive_stories, off_target_stories, task) that downstream seed generation will consume.

You are not evaluating the SKILL.md itself or whether the underlying skill is good. You are evaluating whether this bundle accurately and usefully reflects what the SKILL.md actually says.

## Inputs

The skill the agent was seeded from (skill name + description header, then the SKILL.md body):
```
{{input}}
```

The agent's seeded bundle (parsed JSON with goals, users, positive_stories, off_target_stories, task):
```json
{{output}}
```

If either block above is empty, blank, or contains only schema/instruction text (no actual SKILL content or extracted bundle), state explicitly: "scorer payload missing — span input/output not populated", and pick `none_pass`. Do NOT try to evaluate from instructions alone.

---

## What you are evaluating

### Faithfulness
**PASS if:** every goal, user, story, and task field corresponds to something stated or clearly implied by the SKILL.md. Paraphrase is fine; invention is not.

**FAIL if:** the bundle includes goals or off-target scenarios that are not derivable from the skill body — "reasonable defaults" the agent assumed, generic items it pasted from training data, or features the skill explicitly does not have. Hallucinated items silently corrupt the seed.

### Completeness
**PASS if:** the bundle covers the skill's main responsibilities. If the SKILL.md describes three distinct things the skill does, the goals or stories should reflect all three. The off_target_stories should at least gesture at the kinds of requests this skill should NOT handle (the routing question).

**FAIL if:** an obvious responsibility from the SKILL.md has no corresponding goal, user, or story. Empty `off_target_stories` when the SKILL.md is clearly a routed/triggered skill is also a fail — that population matters for the dataset.

### Specificity
**PASS if:** goals, stories, and task fields are concrete enough to drive eval generation without further guessing. Stories have a clear who/what/why. The task input/output descriptions name the actual artifact being produced.

**FAIL if:** items are generic platitudes ("be helpful", "improve user experience") or task descriptions are abstract ("generates appropriate content"). If the SKILL.md was vague, the agent should reflect that vagueness — but it should not silently add false specificity.

---

## Scoring

Evaluate each of the three dimensions independently and decide PASS or FAIL for each.

Be especially conservative on Faithfulness — a hallucinated goal or off-target scenario is the highest-cost failure here.

---

## How to respond

Give 1-2 sentences of reasoning per dimension (Faithfulness, Completeness, Specificity), explicitly stating PASS or FAIL for each, then choose ONE of these labels based on the total number of passing dimensions:

- `all_pass` — 3 of 3 dimensions pass
- `two_pass` — 2 of 3 dimensions pass
- `one_pass` — 1 of 3 dimensions pass
- `none_pass` — 0 of 3 dimensions pass (or scorer payload was missing)

The harness will record your choice as the score — there is no separate numeric output to write.
