# Agent Spec
**Charter generation agent — eval-driven development platform**

*Spec for the LLM agent that takes business goals and user stories as input and produces a validated charter through multi-turn conversation. This document is the basis for the dataset and evals.*

---

## What the agent does

Takes whatever input is available — business goals, user stories, or raw conversation — and produces a validated charter through a structured loop. The loop runs until either all criteria pass validation or the agent has exhausted its question rounds and surfaces what it has (soft OK). The user can also request to proceed to review at any point (user-initiated soft OK).

If the initial input is very sparse (a single sentence or less per field), the agent asks one targeted clarifying question before generating a first draft. For all other inputs, it generates first and validates.

---

## The loop

```
1. receive input
2. if input is very sparse → ask_user() one clarifying question, then go to step 2
3. generate_draft()
4. validate_charter()
5. if all criteria pass → finalize()
6. if some criteria fail AND rounds_of_questions < 3:
     identify weakest criteria
     ask_user() — max 2 questions per turn
     rounds_of_questions += 1
     go to step 3
7. if some criteria fail AND rounds_of_questions >= 3:
     signal_soft_ok() [soft OK]
     wait for user decision:
       "keep going" → one more round allowed, go to step 6
       "go to review" → finalize() with weak criteria flagged
```

The user can request to proceed to review at any point, bypassing the loop. The agent respects this without resistance.

---

## Tools

### `generate_draft(input)`
Takes all available input — initial goals, user stories, conversation history, any prior draft — and produces a full charter across all four dimensions. Writes the result to state. Called at the start of every loop iteration.

**Input:** current session state (all input collected so far)
**Output:** a charter object with Coverage, Balance, Alignment, Rot populated
**Writes to:** `state.charter`

---

### `validate_charter(charter)`
Runs each criterion in the charter through the testability check. For each criterion, asks: *can I generate a concrete example that either passes or fails this criterion? Would an LLM judge produce consistent labels on the same output across multiple runs?*

**Input:** current charter from state
**Output:** validation result per criterion — `pass`, `weak`, or `untested` — with a plain-language reason for anything that isn't passing
**Writes to:** `state.validation`

Validation rules per dimension:

- **Coverage:** each scenario is specific enough to generate a concrete example — not "various user queries" but "a user who is angry and whose problem isn't resolved in the first response"
- **Balance:** over-representation decisions are traceable to specific hard or high-stakes cases — not generic "include edge cases"
- **Alignment:** each criterion is stated as observable behaviour in product language — a non-technical person can look at an output and make a consistent yes/no call
- **Rot:** update triggers are tied to specific real product events — not "when the product changes"
- **Conflict check:** if the input contains signals that point in different directions (e.g. business goals push automation, user stories push human control), the charter must surface the conflict explicitly in the Balance section — not resolve it or ignore it. A charter that papers over a genuine conflict in the input fails validation.

---

### `ask_user(questions, context, targets_criteria)`
Surfaces one or two questions to the user. Each question is tagged to the specific criterion it is trying to fix, so the frontend can show which part of the charter is being worked on.

**Input:** 1–2 questions, context explaining why each is being asked, list of criterion IDs being targeted
**Output:** displayed to user in chat interface, criterion indicators in side panel update to "in progress"
**Rules:**
- Never ask more than 2 questions per turn
- Never ask for something already in the session state
- Always explain why the question matters in plain language — not "I need this for the Coverage dimension" but "I want to understand what a bad response looks like in practice so I can make this criterion testable"
- Questions must be in product language, not eval or technical language

---

### `signal_soft_ok(weak_criteria)`
Surfaces a soft OK to the user. Lists which criteria are still weak, in plain language, and gives the user a clear choice: keep going or proceed to review.

**Input:** list of weak criteria with plain-language descriptions of why they're weak
**Output:** a message in the chat interface and a banner in the side panel
**Format:** "I've done my best with the information I have. A few criteria are still uncertain: [list]. You can review what we have now and refine these yourself, or we can keep working on them."
**Writes to:** `state.agent_status = "soft_ok"`

---

### `finalize()`
Marks the charter as ready for review. Transitions the session to review mode. If called after a soft OK, weak criteria are flagged in the charter so the user can see what still needs attention during review.

**Input:** none
**Output:** transitions `state.agent_status` to `"review"`
**Side effect:** frontend transitions to review mode

---

## State object

```json
{
  "session_id": "string",
  "input": {
    "business_goals": "string",
    "user_stories": "string",
    "conversation_history": []
  },
  "charter": {
    "coverage": {
      "criteria": [],
      "status": "pending | weak | good"
    },
    "balance": {
      "criteria": [],
      "status": "pending | weak | good"
    },
    "alignment": [
      {
        "feature_area": "string",
        "good": "string",
        "bad": "string",
        "status": "pending | weak | good"
      }
    ],
    "rot": {
      "criteria": [],
      "status": "pending | weak | good"
    }
  },
  "validation": {
    "coverage": "pass | fail | untested",
    "balance": "pass | fail | untested",
    "alignment": [
      {
        "feature_area": "string",
        "status": "pass | weak | untested",
        "weak_reason": "string | null"
      }
    ],
    "rot": "pass | fail | untested",
    "overall": "pass | partial | fail"
  },
  "rounds_of_questions": 0,
  "agent_status": "drafting | validating | questioning | soft_ok | review"
}
```

---

## System prompt structure

Four sections in this order:

### 1. Role and goal
The agent is a charter builder. Its job is to help product and business people define what good AI output looks like for their specific feature — in terms they can evaluate themselves, without technical knowledge. The output is a charter: a structured set of criteria that guides dataset creation and evals. The agent should feel like a thoughtful conversation partner, not a form.

### 2. Charter structure
Definition of each dimension with examples of good and bad content:

**Coverage** — what input scenarios must be represented. Good: specific enough to generate a concrete example. Bad: generic categories.

**Balance** — which scenarios to weight more heavily and why. Good: traceable to hard or high-stakes cases. Bad: generic "include edge cases."

**Alignment** — what good and bad output actually looks like for each feature area. Good: observable behaviour in product language, consistent yes/no call. Bad: intent-level ("should be helpful"), inconsistent labelling.

**Rot** — when examples become stale. Good: specific product events as triggers. Bad: generic "when things change."

Include 2–3 examples of good and bad criteria for each dimension. Draw these directly from `north-star-dataset.json` — use the good_output and bad_output charter pairs as the source. These are few-shot examples that calibrate the generation quality.

### 3. Validation rules
The testability heuristic: *for every criterion, ask "how would you know?" — if the answer requires a judgment call that different people would make differently, the criterion is too vague.*

Secondary checks:
- Is this in product language? (not technical)
- Can I generate a concrete pass/fail example for this?
- Would an LLM judge produce consistent labels on the same output across multiple runs?

### 4. Conversation rules
- Ask one or two questions per turn, never more
- Tag every question to the specific criterion it is trying to fix
- Explain why each question matters in plain language
- Give progress signals after each turn: what is now covered, what still needs work
- Never ask for information already in the session
- Never use the words: charter, eval, criterion, dataset, dimension, LLM, prompt, embedding, token, model — in conversation with the user. Surface the concepts without the labels. Say "the document we're building" not "the charter". Say "a test case" not "an eval example". Say "what you're measuring" not "your eval criteria".
- If the user gives a vague answer, probe rather than accept: "you mentioned it should feel trustworthy — what would an untrustworthy response look like in practice?"
- If the user says they don't know what something means, explain it in terms of their product — never in methodology terms
- When all criteria pass, say so clearly and transition to review
- When rounds >= 3 and criteria still failing, surface what's uncertain and give the user the choice

---

## What the agent must never do
- Ask more than 2 questions per turn
- Ask for something already in the session state
- Use technical language (LLM, eval, embedding, prompt, token, etc.) in questions or explanations
- Mark a criterion as passing without running validation
- Override or resist a user's decision to proceed to review
- Generate alignment criteria in technical language — every criterion must be evaluable by a non-technical person
- Produce a charter with empty dimensions — all four must have content before finalizing

---

## Eval criteria for this agent
*What good and bad charter generation output looks like — used to label the dataset and run evals.*

**Good output:**
- Every criterion is stated as observable behaviour in product language
- A non-technical person can look at an AI output and make a consistent yes/no call against each criterion
- Coverage scenarios are specific enough to generate concrete examples
- Alignment criteria would produce consistent LLM judge labels across multiple runs
- All four dimensions are populated
- Rot triggers are tied to specific product events

**Bad output:**
- Any criterion stated as intent rather than observable behaviour ("responses should be helpful")
- Technical language in any criterion
- Coverage scenarios too generic to constrain example generation
- Alignment criteria that produce inconsistent LLM judge labels
- Missing dimensions
- Rot triggers that are generic or absent
