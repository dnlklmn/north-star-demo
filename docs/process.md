# Process

How this project was built and where it's going.

---

## Phase 1: Design (complete)

Developed the eval-driven development methodology and applied it to both a client scenario (job hunting platform) and the product itself.

**Outputs:**
- 9-step methodology (goals → stories → charter → specs → dataset → judge → evals → feedback)
- Charter structure: Coverage, Balance, Alignment, Rot
- Full specs for agent, backend, and frontend
- 6-example labeled dataset (`north-star-dataset.json`)
- Judge prompt with 4 rubrics
- Eval script (`north-star-eval.py`)
- Spec review with 6 corrections (sparse input, conflict detection, language rules, etc.)

See `docs/session-summary.md` for full details.

---

## Phase 2: Build (complete)

Built the working app from the specs. Deviated from spec where it made sense.

### Backend

Separated agent code into three layers for maintainability:
- **prompt.py** — all prompts, one function per prompt
- **tools.py** — LLM call wrappers with metadata capture (model, tokens, latency)
- **agent.py** — pure control flow, no prompts, no LLM calls

Added turn-level persistence beyond what the spec called for. Every LLM interaction is logged to a `turns` table with full input/output context. This enables replay, debugging, and batch judging.

Added on-demand judge system. `POST /judge/run` scores unjudged turns with dimension-specific rubrics per turn type (generate, validate, chat, suggest). Runs when you decide, not on every turn.

### Frontend

Evolved from the spec's 2-panel layout to a 3-column layout:

| Input | Charter | Agent |
|-------|---------|-------|
| Business goals, role-grouped user stories, suggested stories | Four dimensions with inline editing, suggestions, live completion | Chat with text selection → respond |

Key UI decisions made during build:
- Generate button lives in charter panel (empty state), not input column
- Suggestions appear in both charter panel (criteria) and input column (stories)
- Accepting a suggestion notifies the agent, which responds with implications
- All charter items always editable (no review-gate)
- Non-blocking: edit goals/stories/charter while agent thinks
- Completion labels update immediately on local changes, before validation

### Database

4 tables: `sessions`, `charters`, `turns`, `judgements`

The `turns` table is the key addition beyond the original spec. It stores:
- Input snapshot at time of call
- Full LLM call metadata (prompt, raw response, tokens, latency)
- Parsed output
- Agent message shown to user
- Suggestions returned

---

## Phase 3: Evaluate (next)

The infrastructure is in place. Next steps:

### Run evals on real sessions
- Use the app to generate several charters with different inputs
- Run `POST /judge/run` to score all turns
- Compare judge scores against manual assessment
- Identify where the agent is weakest (likely: over-generating criteria, vague alignment descriptions)

### Calibrate the judge
- Run `north-star-eval.py` against the 6 labeled dataset examples
- Compare judge output to expected labels
- Adjust judge prompts in `main.py:_build_judge_prompt()` based on disagreements
- The judge should be conservative: false positives (calling weak output good) are worse than false negatives

### Fix known agent issues
- **Over-generation**: agent sometimes produces 5+ criteria from sparse input. The prompt says not to, but it still does. Use judge data to measure how often.
- **Chat regeneration**: agent sometimes regenerates the full charter on chat turns instead of making minimal updates. Need to tighten the conversational turn prompt.
- **Sparse input**: spec calls for asking a clarifying question before generating when input is very thin. Not yet implemented.
- **Brevity**: agent responses are still too verbose despite prompt instructions. May need stronger constraints or a post-processing step.

### Build the feedback loop
- Track which suggestions users accept vs dismiss (already captured in conversation history)
- Track which charter items users edit after generation (captured via PATCH endpoint)
- Use this data to improve suggestion quality and generation accuracy over time

---

## Phase 4: Iterate (future)

- Output specs per feature area (step 5 of methodology — not yet built)
- Dataset generation from charter (step 6)
- Judge prompt generation from charter (step 7)
- Multi-session charter comparison
- Team collaboration (multiple users on one charter)
- Document import (was cut from MVP)

---

## Architecture decisions

| Decision | Rationale |
|----------|-----------|
| Separate prompt/tools/agent | Prompts change constantly during iteration. Control flow changes rarely. Keep them apart so prompt tuning doesn't risk breaking orchestration. |
| Turn-level logging | You can't improve what you can't measure. Logging every LLM call with full context lets you replay, debug, and judge any interaction. |
| On-demand judging | Running judge on every turn adds latency and cost. Batch judging when you're ready to look at results is cheaper and gives you control. |
| 3-column layout | Input, output, and agent all visible simultaneously. No mode switching. User can work on input while reading agent feedback. |
| Suggestions as first-class UI | One-click additions reduce friction. The agent can propose, the user decides. Acceptance feeds back to the agent. |
| Non-blocking editing | The agent thinking shouldn't block the user from working. Charter editing and input changes happen locally, agent catches up. |
