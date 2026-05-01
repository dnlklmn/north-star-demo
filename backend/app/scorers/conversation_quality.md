---
name: conversation_quality
turn_type: discovery
phases: [goals, users, stories]
sample_rate: 0.2
description: Evaluates the question the agent asks in any discovery phase. Sample at 1-in-5 to keep cost down.
returns: per-dimension score (specificity, non-repetition, phase-appropriateness) + overall verdict
---

# Conversation Quality

You are evaluating a single question the discovery agent just asked the user. The agent's job is to elicit information in one turn — one good question per turn, building on what's already known, appropriate to the current phase.

## Inputs

The conversation history. Starts with a `[Current discovery phase: …]` tag (one of `goals`, `users`, `stories`) — that tells you which phase to evaluate phase-appropriateness against — followed by one line per turn (`user: …` / `assistant: …`):
```
{{input}}
```

The agent's latest message — its conversational question text, possibly followed by a fenced ```extraction block (ignore the extraction block when judging the question itself):
```
{{output}}
```

If either block above is empty, blank, or contains only schema/instruction text (no actual conversation turns or agent question), state explicitly: "scorer payload missing — span input/output not populated", and pick `none_pass`. Do NOT try to evaluate from instructions alone.

---

## What you are evaluating

### Specificity
**PASS if:** the question is concrete and answerable. The user can give a meaningful answer in one or two sentences. "What's the ideal output when a customer asks about a refund for a damaged item?" passes. "Tell me more about your goals" does not.

**FAIL if:** the question is open-ended to the point of being unanswerable, or so abstract that any answer would be a guess. "What do you want?", "Anything else?", "How do you feel about it?" — all fail.

A specific question gives the user something concrete to react to.

### Non-repetition
**PASS if:** the question advances from what's already known. It does not re-ask things the user already covered, even with different wording.

**FAIL if:** the question rehashes prior territory — asks for goals when goals are already extracted, asks "who are your users" twice, or paraphrases its own previous question because it ignored the user's answer.

Look at the conversation history. The user's prior answers should change the agent's next question.

### Phase appropriateness
**PASS if:** the question fits the current phase.
- `goals` — questions about *what the AI feature should achieve* for the business or the user.
- `users` — questions about *who* will use it and what they need.
- `stories` — questions about *specific scenarios* the AI feature must handle, with a who/what/why shape.

**FAIL if:** the question is from a different phase. Asking about edge cases in the goals phase, or asking about high-level business outcomes in the stories phase, both fail. The phase exists to keep the conversation focused.

---

## Scoring

Evaluate each of the three dimensions independently and decide PASS or FAIL for each.

This scorer is sampled — it does not run on every turn. Be conservative; a noisy scorer in production produces noise alerts.

---

## How to respond

Give 1-2 sentences of reasoning per dimension (Specificity, Non-repetition, Phase appropriateness), explicitly stating PASS or FAIL for each, then choose ONE of these labels based on the total number of passing dimensions:

- `all_pass` — 3 of 3 dimensions pass
- `two_pass` — 2 of 3 dimensions pass
- `one_pass` — 1 of 3 dimensions pass
- `none_pass` — 0 of 3 dimensions pass (or scorer payload was missing)

The harness will record your choice as the score — there is no separate numeric output to write.
