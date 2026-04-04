# North Star

An eval-driven development platform. Define what good AI output looks like — before writing a single eval.

Users describe their AI feature through a guided conversation. The agent builds a **charter** (a structured quality definition), then helps generate a labeled dataset, derive evaluation scorers, and suggest revisions to keep examples aligned with the charter.

## The idea

You start from business goals and user stories. The agent interviews you to understand what your AI feature should do, then generates a charter with four dimensions:

- **Coverage** — Input scenarios that must be tested ("customer asks about a delayed order with no ETA")
- **Balance** — Which scenarios to weight more heavily ("escalation cases over-represented because that's where frustration occurs")
- **Alignment** — What good vs bad output looks like per feature area (observable, not intent-level)
- **Rot** — When criteria become stale ("when the return policy changes")

From the charter, you can:

1. **Generate a golden dataset** — synthetic examples covering every criterion x feature area
2. **Review and curate** — auto-judge examples against the charter, approve/reject/edit
3. **Suggest revisions** — for examples that fail review, the agent proposes minimal targeted fixes you can accept or dismiss
4. **Generate scorers** — executable Python evaluation functions derived from charter criteria
5. **Analyze coverage gaps** — find what's missing and generate targeted examples to fill holes

---

## Phases

The app guides users through a structured flow. Each phase builds on the previous one.

### Phase 1: Discovery (Goals, Users, Stories)

Three sub-phases, each one question at a time:

| Sub-phase | What the agent does | What gets extracted |
|-----------|--------------------|--------------------|
| **Goals** | Breaks down business objectives using issue tree decomposition, probes with 5 Whys | Business goals (deduplicated, first-40-chars matching) |
| **Users** | Identifies user types using MECE principle — direct users, upstream providers, downstream consumers | User personas |
| **Stories** | Elicits what each user type needs to accomplish using Jobs To Be Done framing | User stories (who/what/why) |

Each turn: agent asks one question, extracts entities from the response, checks readiness to advance. Users can also edit extracted items directly in the left panel.

### Phase 2: Charter Generation

When the user advances from stories, the agent:

1. **Generates a draft** — builds a 5-part charter (task definition + coverage/balance/alignment/rot) from the discovered goals, users, and stories
2. **Validates** — checks each dimension for testability (Is it traceable to user input? Can you generate a concrete test? Would two judges agree?)
3. **Determines status** — all passing = ready for review; some weak = asks follow-up questions; max rounds reached = soft OK
4. **Generates suggestions** — concrete items the user can click to add to weak sections

The user can then refine through conversation or direct editing. Each edit triggers revalidation.

### Phase 3: Dataset

Once the charter is finalized:

- **Generate** examples from charter (coverage criterion x feature area x good/bad label)
- **Import** from CSV or JSON
- **Auto-review** with LLM judge — each example gets a verdict: suggested label, confidence, reasoning, issues
- **Suggest revisions** — for examples with issues, proposes targeted fixes (original vs proposed diff). User accepts, dismisses, or edits. Never auto-applied.
- **Gap analysis** — coverage matrix showing which scenarios lack examples
- **Export** approved examples as JSON

### Phase 4: Scorers

Generates complete Python evaluation functions from the charter:

- **Alignment scorers** — one per alignment entry, with an LLM-as-judge prompt specific to the good/bad definitions
- **Coverage scorers** — one per coverage criterion, checking if the output handles that scenario

Each scorer is a working function with signature `def scorer_name(output: str, input: str) -> float` returning 0.0-1.0, with a complete judge prompt baked in (not a stub).

---

## Architecture

```
frontend/          React 19 + TypeScript + Tailwind CSS v4 + Vite
backend/app/       FastAPI + Claude API + PostgreSQL
```

### Backend layers

The backend separates concerns into three layers:

```
prompt.py    All prompts. One function per prompt. Edit here to change agent behavior.
tools.py     LLM call wrappers. Sends prompts to Claude, parses responses.
             Each call returns (structured_data, [call_metadata]).
agent.py     Control flow only. State transitions, orchestration.
             No prompts, no direct LLM calls.
main.py      API endpoints + request handling.
models.py    Pydantic models for all request/response validation.
db.py        PostgreSQL persistence layer.
```

### Agent orchestration (agent.py)

The agent is a state machine. `run_agent_turn()` routes based on current state:

```
User sends input
  |
  +-- No charter + discovery phase?
  |     -> Discovery turn (ask one question, extract entities)
  |     -> Check readiness signals (ready_for_users, ready_for_stories, ready_for_charter)
  |
  +-- No charter + charter phase (or regenerate)?
  |     -> Generate draft -> Validate -> Determine status -> Suggest
  |
  +-- Has charter + user message?
  |     -> Chat turn (conversational response, optional charter-update block)
  |     -> Parse updates + suggestions from response
  |     -> Revalidate if charter was modified
  |
  -> Log turn to DB (input, raw output, parsed result, call metadata)
  -> Update state, return result
```

**Status transitions:**

```
drafting -> discovery turns -> questioning (weak criteria) -> review (all passing)
                                    |                            |
                                    +-> soft_ok (max rounds)     +-> finalize
```

### Frontend structure

Three-column layout:

| Input panel | Charter / Dataset | Agent conversation |
|-------------|-------------------|--------------------|
| Goals, user types, stories (editable) | Charter dimensions with progress indicators, inline editing, suggestions; Dataset table with review workflow | One question at a time, contextual suggestions |

---

## Prompts

Every LLM interaction uses a prompt function in `prompt.py`. Here's the complete catalog:

### Discovery prompts

| Function | Used by | Purpose |
|----------|---------|---------|
| `build_discovery_turn_prompt(state, user_message)` | Discovery turns | Routes to phase-specific sub-prompt (goals/users/stories). Returns conversational message + extraction block. |

Internally delegates to `_build_goals_phase_prompt()`, `_build_users_phase_prompt()`, `_build_stories_phase_prompt()` based on `state.discovery_phase`.

### Charter prompts

| Function | Used by | Purpose |
|----------|---------|---------|
| `build_generate_draft_prompt(state, creativity)` | Charter generation | Generates 5-part charter JSON from goals + stories. Creativity 0.0-0.3 = strict (only stated facts), 0.6+ = creative expansion. |
| `build_validate_charter_prompt(state)` | Validation | Checks each dimension for testability. Returns pass/weak/fail per dimension. |
| `build_conversational_turn_prompt(state, user_message)` | Chat refinement | Conversational turn with optional `charter-update` and `suggestions` blocks in response. |
| `build_generate_suggestions_prompt(state)` | Suggestion generation | Proposes 3-6 concrete items for empty/weak charter sections. |

### Stateless helper prompts

| Function | Used by | Purpose |
|----------|---------|---------|
| `build_suggest_goals_prompt(goals)` | Goal suggestions | Suggests 2-4 complementary business goals. |
| `build_evaluate_goals_prompt(goals)` | Goal quality check | Flags goals that are too broad, too technical, not measurable. |
| `build_suggest_stories_prompt(goals, stories)` | Story suggestions | Suggests 2-3 user stories aligned with existing goals. |

### Dataset prompts

| Function | Used by | Purpose |
|----------|---------|---------|
| `build_synthesize_examples_prompt(charter, feature_areas, coverage_criteria, count)` | Example generation | Generates labeled examples per coverage criterion x feature area. Inputs/outputs must match task definition format. |
| `build_review_examples_prompt(charter, examples)` | Auto-review | Judges examples against charter. Returns suggested_label, confidence, reasoning, issues per example. |
| `build_dataset_chat_prompt(charter, dataset_stats, user_message, history)` | Dataset chat | Conversational agent for dataset curation. Can emit `dataset-action` blocks (generate, show_coverage, auto_review, export). |
| `build_gap_analysis_prompt(charter, dataset_stats, examples)` | Gap analysis | Analyzes coverage matrix. Identifies coverage gaps, feature area gaps, balance issues, label gaps. |

### Scorer and revision prompts

| Function | Used by | Purpose |
|----------|---------|---------|
| `build_generate_scorers_prompt(charter)` | Scorer generation | Generates complete Python LLM-as-judge functions from alignment entries and coverage criteria. One scorer per criterion. |
| `build_revise_examples_prompt(charter, examples_with_verdicts)` | Revision suggestions | Takes examples + their review verdicts, proposes minimal targeted revisions to fix identified issues. |

### Schema detection prompts

| Function | Used by | Purpose |
|----------|---------|---------|
| `build_detect_schema_prompt(content, content_type)` | Schema detection | Detects format (JSON/CSV/freeform) and infers field structure from pasted content. |
| `build_infer_schema_prompt(examples, charter)` | Schema inference | Infers input/output format from existing dataset examples. |
| `build_import_url_prompt(content, url, detected_type)` | URL import | Extracts task definition from URL content (OpenAPI, JSON data, HTML docs). |

---

## API endpoints

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions` | Create session, run initial agent turn |
| GET | `/sessions` | List all sessions |
| GET | `/sessions/{id}` | Get full session state |
| PATCH | `/sessions/{id}/name` | Rename session |
| PATCH | `/sessions/{id}/input` | Save goals/stories without agent |
| DELETE | `/sessions/{id}` | Delete session and all data |

### Agent interaction

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/{id}/message` | Send message, get agent response |
| POST | `/sessions/{id}/advance-phase` | Advance discovery phase |
| POST | `/sessions/{id}/proceed` | Proceed to review |
| PATCH | `/sessions/{id}/charter` | Edit charter sections |
| POST | `/sessions/{id}/validate` | Run validation |
| POST | `/sessions/{id}/suggest` | Generate suggestions for weak sections |
| POST | `/sessions/{id}/finalize` | Finalize charter |

### Dataset

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/{id}/dataset` | Create dataset |
| GET | `/sessions/{id}/dataset` | Get dataset with examples |
| POST | `/datasets/{id}/synthesize` | Generate examples from charter |
| POST | `/datasets/{id}/import` | Import examples |
| POST | `/datasets/{id}/review` | Auto-review pending examples |
| POST | `/datasets/{id}/suggest-revisions` | Suggest fixes for examples with issues |
| GET | `/datasets/{id}/gaps` | Coverage gap analysis |
| POST | `/datasets/{id}/export` | Export approved examples |
| POST | `/datasets/{id}/examples` | Create example manually |
| PATCH | `/datasets/{id}/examples/{eid}` | Update example |
| DELETE | `/datasets/{id}/examples/{eid}` | Delete example |

### Scorers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/{id}/generate-scorers` | Generate scorers from charter via LLM |
| PATCH | `/sessions/{id}/scorers` | Save scorers to session |

### Schema detection

| Method | Path | Description |
|--------|------|-------------|
| POST | `/detect-schema` | Detect schema from pasted content |
| POST | `/infer-schema` | Infer schema from dataset examples |
| POST | `/import-from-url` | Extract schema from URL |

---

## Database

PostgreSQL with five tables:

| Table | Purpose |
|-------|---------|
| **sessions** | Main state store. Full session state as JSONB (charter, validation, input, discovery phase, conversation history). |
| **charters** | Immutable snapshots created on finalization. |
| **turns** | Every LLM interaction logged. Input snapshot, raw prompt/response, parsed output, token counts, latency. Full replay capability. |
| **examples** | Dataset examples with feature_area, input, expected_output, coverage_tags, label, review_status, judge_verdict, revision_suggestion. |
| **datasets** | Dataset metadata linking to session, with charter snapshot and stats. |

---

## Setup

### Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e .

# Set environment variables
cp .env.example .env  # then edit with your values
# DATABASE_URL=postgresql://localhost:5432/northstar
# ANTHROPIC_API_KEY=sk-...

uvicorn app.main:app --port 5000 --reload
```

### Frontend
```bash
cd frontend
npm install --legacy-peer-deps
npm run dev
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| DATABASE_URL | postgresql://localhost:5432/northstar | PostgreSQL connection |
| ANTHROPIC_API_KEY | (required) | Claude API key |
| MODEL_NAME | claude-sonnet-4-20250514 | Model for all LLM calls |
| MAX_QUESTION_ROUNDS | 3 | Refinement rounds before soft_ok |
